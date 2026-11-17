// AC-22 行为变异校准(R-05 阳性埋雷):对 worktree.ts 与宿主接线逐个注入单一故障,在隔离副本里跑 worktree.test.ts(真实临时 git 仓库),
// 每个变异都必须让至少一条具名测试失败;注入点在源码里必须恰好出现 1 次。原样副本必须全绿(阴性对照)。
// 用法: node packages/server/proof/worktree-mutations.mjs [结果文件]
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PKG = path.resolve(import.meta.dirname, "..");
const ROOT = path.resolve(PKG, "../..");
const TEST = "src/worktree.test.ts";

const M = [
  ["W01 合并路径推进不带旧值(CAS 失效)", "worktree.ts", 'if (gitOk(this.cfg.repo, ["update-ref", ref, merged, head]))', 'if (gitOk(this.cfg.repo, ["update-ref", ref, merged]))'],
  ["W02 主线已推进也直接快进", "worktree.ts", 'if (gitOk(this.cfg.repo, ["merge-base", "--is-ancestor", head, cand])) {', "if (true) {"],
  ["W03 主线推进后不跑重验", "worktree.ts", "const v = await runVerify(this.cfg.verify, idir);", 'const v = { ok: true, output: "" };'],
  ["W04 重验跑在任务工作树而不是合并结果上", "worktree.ts", "const v = await runVerify(this.cfg.verify, idir);", "const v = await runVerify(this.cfg.verify, ws.dir);"],
  ["W05 没配重验命令也合入", "worktree.ts", "if (!this.cfg.verify) {", "if (!this.cfg.verify && false) {"],
  ["W06 W5 未修复也允许再合", "worktree.ts", 'if (ws.state === "W5_Conflict") return { ok: false, ws, reason: "unresolved-conflict"', 'if (ws.state === "W5_Conflict" && false) return { ok: false, ws, reason: "unresolved-conflict"'],
  ["W07 冲突后没有新提交也转回 W3", "worktree.ts", "if (ws.state === \"W5_Conflict\" && sha === ws.candidateSha) return ws;", ""],
  ["W08 两个任务共用一个工作目录", "worktree.ts", 'const dir = path.join(this.root, taskId.replace(/[^A-Za-z0-9._-]/g, "-"));', 'const dir = path.join(this.root, "shared");'],
  ["W09 不查目标分支是否检出在工作区", "worktree.ts", 'else if (line === `branch ${ref}` && !bare) throw', "else if (false) throw"],
  ["W10 合入后不清理任务工作树", "worktree.ts", '    gitOk(this.cfg.repo, ["worktree", "remove", "--force", ws.dir]);\n    rmSync(ws.dir, { recursive: true, force: true });\n', ""],
  ["W11 合并冲突当成功推进", "worktree.ts", '          gitOk(idir, ["merge", "--abort"]);\n', '          gitOk(idir, ["merge", "--abort"]);\n          if (gitOk(this.cfg.repo, ["update-ref", ref, cand, head])) return { ok: true, ws: this.merged(ws, head, cand, head), mode: "merged-and-verified", attempts: attempt };\n'],
  ["W12 宿主:Compute 不用任务 worktree", "host.ts", "      cwd = this.computeCwdFor(e.taskId);", "      cwd = this.opts.computeCwd?.(e.taskId);"],
  ["W13 宿主:验收不等合入直接记 T8", "host.ts", "      const code = this.acceptCodeTaskTx(taskId, by);\n      if (code) return code;\n", ""],
  ["W14 宿主:合入失败也记验收", "host.ts", "        summary = `合入失败,", "        if (t.state === \"T8a_Delivered\" && t.delivery) this.stepTaskTx(taskId, { kind: \"UserAccept\", taskId, by, deliveryRound: t.delivery.round, commit: t.delivery.commit });\n        summary = `合入失败,"],
  ["W15 宿主:交付不钉候选提交", "host.ts", "              commit = `git:${pinned.candidateSha}`;\n", ""],
  ["W16 宿主:冲突没修也能直接说通过", "host.ts", '    if (ws.state === "W5_Conflict") throw new HostError("conflict"', '    if (false) throw new HostError("conflict"'],
  ["W17 宿主:合入失败不告诉联系人", "host.ts", "      if (owner) {\n        const payload: Inbound = { kind: \"compute\", roomId: doc.roomId, taskId, computeId: t.computeId ?? \"-\", signal: r.ok", "      if (owner && r.ok) {\n        const payload: Inbound = { kind: \"compute\", roomId: doc.roomId, taskId, computeId: t.computeId ?? \"-\", signal: r.ok"],
];

function run(dir) {
  const r = spawnSync(process.execPath, ["--no-warnings", "--test", "--test-reporter=tap", "--test-concurrency=1", "--test-timeout=120000", "--test-force-exit", TEST], { cwd: dir, encoding: "utf8", timeout: 900_000 });
  const failed = [...(r.stdout ?? "").matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1]);
  const passed = [...(r.stdout ?? "").matchAll(/^ok \d+ - (.+)$/gm)].map((m) => m[1]);
  return { code: r.status, failed, passed };
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gg-wt-mut-"));
const copy = (name) => {
  const d = path.join(tmp, name);
  fs.cpSync(PKG, d, { recursive: true, filter: (s) => !s.includes(`${path.sep}proof`) && !s.includes(`${path.sep}node_modules`) });
  fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(d, "node_modules"));
  return d;
};
const out = [];
const log = (s) => {
  out.push(s);
  console.log(s);
};
let ok = true;
try {
  const base = run(copy("base"));
  if (base.code !== 0 || base.failed.length || !base.passed.length) {
    log(`✗ 阴性对照没全绿:${base.passed.length} 绿 / ${base.failed.length} 红 ${base.failed.join(";")}`);
    ok = false;
  } else log(`✓ 阴性对照:${base.passed.length} 条全绿`);
  for (const [name, file, from, to] of M) {
    const d = copy(name.split(" ")[0]);
    const f = path.join(d, "src", file);
    const src = fs.readFileSync(f, "utf8");
    const hits = src.split(from).length - 1;
    if (hits !== 1) {
      log(`✗ ${name}:注入点出现 ${hits} 次(应为 1)`);
      ok = false;
      continue;
    }
    fs.writeFileSync(f, src.replace(from, to));
    const r = run(d);
    // 变异让测试卡住(等宿主安静超时)被整体超时杀掉时 TAP 不完整:通过数少于阴性对照也算被发现,单独标出
    if (r.failed.length === 0 && r.passed.length < base.passed.length) log(`✓ ${name}:${r.passed.length} 绿 / 未跑完(退出码 ${r.code}),阴性对照 ${base.passed.length} 条全绿,变异下没有全部通过`);
    else if (r.failed.length === 0) {
      log(`✗ ${name}:存活(${r.passed.length} 绿)`);
      ok = false;
    } else log(`✓ ${name}:${r.passed.length} 绿 / ${r.failed.length} 红,被「${r.failed[0]}」发现`);
    fs.rmSync(d, { recursive: true, force: true });
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
log(`${M.length} 个变异`);
log(ok ? "变异校准通过" : "变异校准失败");
if (process.argv[2]) fs.writeFileSync(process.argv[2], `${out.join("\n")}\n`);
process.exit(ok ? 0 : 1);
