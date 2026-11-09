// AC-04 行为变异校准(R-05 阳性埋雷):对 artifacts.ts 与宿主接线逐个注入单一故障,在隔离副本里跑 artifacts.test.ts(真实临时 git 仓库),
// 每个变异都必须让至少一条具名测试失败;注入点在源码里必须恰好出现 1 次。原样副本必须全绿(阴性对照)。
// 用法: node packages/server/proof/artifacts-mutations.mjs [结果文件]
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PKG = path.resolve(import.meta.dirname, "..");
const ROOT = path.resolve(PKG, "../..");
const TEST = "src/artifacts.test.ts";

const M = [
  ["A01 不按内容去重(每次交付写新文件)", "artifacts.ts", "const file = path.join(this.dir, `${sha256}${ext}`);", "const file = path.join(this.dir, `${sha256}-${Date.now()}-${Math.random()}${ext}`);"],
  ["A02 sha256 按文件名而不是内容算", "artifacts.ts", 'const sha256 = createHash("sha256").update(data).digest("hex");', 'const sha256 = createHash("sha256").update(name).digest("hex");'],
  ["A03 读出不校验内容 hash", "artifacts.ts", "    if (createHash(\"sha256\").update(data).digest(\"hex\") !== meta.sha256) throw", "    if (false) throw"],
  ["A04 同一工件重复登记", "artifacts.ts", "INSERT OR IGNORE INTO gg_artifacts", "INSERT OR REPLACE INTO gg_artifacts"],
  ["A05 不跳过隐藏目录", "artifacts.ts", 'if (n.startsWith(".") || n === "node_modules") continue;', 'if (n === "node_modules") continue;'],
  ["A06 不按 Compute 启动时间过滤旧文件", "artifacts.ts", "st.mtimeMs >= sinceMs", "true"],
  ["A07 代码文件也进卡片", "host.ts", "this.worktrees.changedFiles(ws).filter(isReadable)", "this.worktrees.changedFiles(ws)"],
  ["A08 卡片读基线提交而不是候选提交", "host.ts", "const data = this.worktrees.readAt(ws.candidateSha, f);", "const data = this.worktrees.readAt(ws.baseSha, f);"],
  ["A09 交付消息不带工件", "host.ts", 'if (arts.length && !r.duplicate) run(this.db, "INSERT OR IGNORE INTO gg_msg_artifacts', 'if (false) run(this.db, "INSERT OR IGNORE INTO gg_msg_artifacts'],
  ["A10 任务视图的文件工件不带 sha256", "host.ts", "kind: \"file\" as const, sha256: a.sha256, bytes", "kind: \"file\" as const, bytes"],
  ["A11 点开不带回正文", "host.ts", "text: textual && r.data.length <= MAX_INLINE_TEXT ? r.data.toString(\"utf8\") : null", "text: null"],
  ["A12 没有代码仓时不收工件", "host.ts", "    if (!cwd || !started) return out;", "    return out;"],
];

function run(dir) {
  const r = spawnSync(process.execPath, ["--no-warnings", "--test", "--test-reporter=tap", "--test-concurrency=1", TEST], { cwd: dir, encoding: "utf8", timeout: 900_000 });
  const failed = [...(r.stdout ?? "").matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1]);
  const passed = [...(r.stdout ?? "").matchAll(/^ok \d+ - (.+)$/gm)].map((m) => m[1]);
  return { code: r.status, failed, passed };
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gg-art-mut-"));
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
