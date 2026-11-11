// 找旧消息(T-177 G4)的定点变异校准(实施方案 §8 G4-01～03 的一对一关键变异 + 审查条件 G4-a、G4-b、G1-a 与需求 D06 §3 的判据):
// 每个变异只注入一处故障(每个注入点必须恰好出现 1 次),在隔离副本里跑本片相关测试文件;**指定的具名测试**必须在原样副本里通过、
// 在变异副本里按名失败(被 --test-timeout 判掉的不算、文件级加载失败不算);原样副本必须全绿(阴性对照)。并发 1。
// 副本带整份 packages/,node_modules/@g-group/* 链到副本自己的包(跨包注入内核测的才是注入后的代码);其余依赖(含 acp-kernel)链回原树。
// 用法: node packages/server/proof/history-mutations.mjs    只跑某几个: MUT_ONLY=K1,S3 node ...
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const TESTS = [
  "packages/kernel/src/history-tools.test.ts",
  "packages/server/src/history-tools.test.ts",
  "packages/server/src/history-prefetch.test.ts",
  "packages/adapter-pi-contact/src/history-tools.test.ts",
  "packages/adapter-pi-contact/src/mind.test.ts",
];
const K = "packages/kernel/src/history-tools.ts";
const S = "packages/server/src/history.ts";
const H = "packages/server/src/host.ts";
const T = "packages/adapter-pi-contact/src/tools.ts";
const MIND = "packages/adapter-pi-contact/src/mind.ts";
// 具名测试(按名字前缀认,前缀须在原样副本里恰好认出 1 条通过的测试)
const KT1 = "消息版本是作用到它的最后一个编辑或撤回事件的 seq";
const KT2 = "预取挑选:";
const KT3 = "回读邻域:";
const C1 = "G4-01 交给检索的文档只有当前可见的最新版本";
const C2 = "G4-01 联系人同时在私聊和群里";
const CA = "G4-a 一轮同时带群和私聊的新消息";
const E1 = "G4-02 检索之后、返回之前被编辑或撤回";
const E2 = "G4-02 检索之后、返回之前联系人被移出这个群";
const E3 = "G4-02 回读时每条邻居单独核对";
const E4 = "G4-02 回读超过回读预算就分页";
const P1 = "G4-03 模型不调工具,第 5 块也有最多 3 条旧消息指针";
const P2 = "G4-03 关掉预取第 5 块就没有旧消息指针";
const P3 = "G4-03 预取不挤显式引用";
const B1 = "G4-b 预取超时不挡这一轮";
const B2 = "G4-b 预取出错不挡这一轮";
const A1 = "query_history 是声明给模型的一个内置只读查询工具";
const A2 = "找旧消息:没给查询口、宿主拒绝或查询口出错";
const AM = "首个请求恰好是五块";

/** [编号, 名字, [[文件, 原文, 改成]...], 必须按名失败的具名测试] */
const M = [
  ["K1", "消息版本取消息自己的 seq,不看编辑与撤回事件(G1-a)", [[K, "    } else rev.set(e.body.target, Math.max(rev.get(e.body.target) ?? e.body.target, e.seq));\n", "    }\n"]], [KT1, C1]],
  ["K2", "撤回的仍带正文", [[K, '      text: state === "ok" ? m.text : "",', "      text: m.text,"]], [KT1]],
  ["K3", "私聊回退撤下的当作可读", [[K, 'm.retracted ? "retracted" : hidden(m.seq) ? "hidden" : "ok";', 'm.retracted ? "retracted" : "ok";']], [KT1, E3]],
  ["K4", "预取不切断崖", [[K, "  return ranked.slice(0, cut);", "  return ranked.slice(0);"]], [KT2]],
  ["K5", "预取不过最小分", [[K, "        .filter(({ h }) => h.score >= policy.minScore)\n", ""]], [KT2]],
  ["K6", "预取同一条不去重", [[K, "      if (!h || seen.has(h.ref) || out.length >= policy.max) continue;", "      if (!h || out.length >= policy.max) continue;"]], [KT2]],
  ["K7", "预取上限不是 3", [[K, "export const PREFETCH_MAX = 3;", "export const PREFETCH_MAX = 5;"]], [P1]],
  ["K8", "回读前后条数不夹上限", [[K, "Math.min(n, HISTORY_NEIGHBORS_MAX)", "n"]], [KT3]],
  ["K9", "回读不管回读预算(无界邻域)", [[K, "      if (cost > left || anchorCut) stopB = true;", "      if (anchorCut) stopB = true;"], [K, "      if (cost > left || anchorCut) stopA = true;", "      if (anchorCut) stopA = true;"]], [E4, KT3]],
  ["K10", "续读位置指回已读的那条", [[K, "moreBefore: b < wantBefore ? { seq: lines[idx - b - 1]!.seq,", "moreBefore: b < wantBefore ? { seq: lines[idx - b]!.seq,"]], [KT3]],
  ["K11", "中心那条超预算也整条给", [[K, "  if (total > left) {", "  if (false) {"]], [KT3]],
  ["K12", "撤回的邻居不给占位(邻居不单独核对)", [[K, '    if (l.state === "retracted") out.push(', "    if (false) out.push("]], [E3]],
  ["K13", "预取不标旧消息", [[K, 'export const PREFETCH_REF = "旧消息(宿主按本轮新消息预取,供参考,不是新要求)";', 'export const PREFETCH_REF = "相关消息";']], [P1]],
  ["K14", "预取指针给全文不给一行预览", [[K, "`${l.roomId} #${l.seq} · ${author(l.sender)} · ${l.at} · ${previewLine(l.text)}`", "`${l.roomId} #${l.seq} · ${author(l.sender)} · ${l.at} · ${l.text}`"]], [KT2]],
  ["S1", "先检索后过滤:把日志里每个版本(含撤回、回退撤下、编辑前旧稿)都交给检索,返回前再筛", [[S, "    const docs = historyDocs(target.flatMap((r) => this.lines(r)));\n", '    const docs = target.flatMap((r) => loadLog(this.d.db.store, `room:${r}`).log.events.flatMap((e) => (e.body.kind === "retract" ? [] : [{ ref: historyRef(r, e.body.kind === "message" ? e.seq : e.body.target), role: "user" as const, text: e.body.text }])));\n']], [C1]],
  ["S2", "工具范围用联系人的全部会话,不限本轮新输入所在的会话(G4-a)", [[H, "...this.history.tools(contactId, new Set(fresh.map((f) => f.roomId))) };", "...this.history.tools(contactId, new Set(this.roomsOfContact(contactId).map((r) => r.id))) };"]], [C2]],
  ["S3", "返回前不核撤回与回退", [[S, '      if (l && l.state === "ok") out.push(l);', "      if (l) out.push(l);"]], [E1]],
  ["S4", "返回前不核成员范围(退群在途)", [[S, "      if (!p || !rooms.has(p.roomId)) continue;", "      if (!p) continue;"]], [E2]],
  ["S5", "返回用检索时的副本(缓存原文与旧版本)", [[S, "    const found = this.verify(contactId, new Set(target), hits.map((h) => h.ref));\n    return renderHistoryHits(", "    const found = this.verify(contactId, new Set(target), hits.map((h) => h.ref)).map((l) => ({ ...l, revision: l.seq, text: docs.find((d) => d.ref === historyRef(l.roomId, l.seq))?.text ?? l.text }));\n    return renderHistoryHits("]], [E1]],
  ["S6", "预取不排除已在上下文里的(显式引用被重复)", [[S, "filter((l) => !inContext.has(historyRef(l.roomId, l.seq)) && l.text.trim() !== q.text.trim())", "filter((l) => l.text.trim() !== q.text.trim())"]], [P3]],
  ["S7", "预取没有时限(不和计时器赛跑)", [[S, "      got = await Promise.race([work, timeout]);", "      got = await work;"]], [B1]],
  ["S8", "同步检索超过时限不判超时", [[S, '    if (got === "timeout" || performance.now() - started > timeoutMs) {', '    if (got === "timeout") {']], [B1]],
  ["S9", "预取出错冒泡,这一轮失败", [[S, '      report("error", { error: e instanceof Error ? e.message : String(e) });\n      return { pointers: [notDone("出错")], status: "error" };', "      throw e;"]], [B2]],
  ["S10", "预取每条新消息搜本轮全部会话(不只它自己的,G4-a)", [[S, "        const docs = historyDocs(byRoom.get(q.roomId)!.filter(", "        const docs = historyDocs([...byRoom.values()].flat().filter("]], [CA]],
  ["S11", "去掉预取", [[H, "    const pre = this.opts.historyPrefetch === false ? null : await this.history.prefetch(", "    const pre = true ? null : await this.history.prefetch("]], [P1]],
  ["S12", "关不掉预取", [[H, "    const pre = this.opts.historyPrefetch === false ? null : await this.history.prefetch(", "    const pre = false ? null : await this.history.prefetch("]], [P2]],
  ["S13", "预取放进固定前缀(system)", [[H, "      system: CONTACT_SYSTEM,\n      tools: CONTACT_TOOLS,\n      persona: identityOf(contactId, contact),", '      system: [CONTACT_SYSTEM, ...extra.map((p) => p.text)].join("\\n"),\n      tools: CONTACT_TOOLS,\n      persona: identityOf(contactId, contact),']], [P2]],
  ["S14", "整轮超预算时不先丢预取", [[H, '        if (!(pre?.pointers.length && e instanceof RoundAssembleError && e.reason === "over-budget")) throw e;', "        throw e;"]], [P3]],
  ["S15", "和新消息一字不差的旧消息照样预取", [[S, " && l.text.trim() !== q.text.trim())", ")"]], [P1]],
  ["A1", "查询工具不声明给模型", [[T, '  "progress_rerun",\n  "query_history",\n] as const);', '  "progress_rerun",\n] as const);']], [A1, AM]],
  ["A2", "查询口出错说成没找到", [[MIND, "            return { content: [{ type: \"text\", text: `找旧消息出错(不代表没说过):${redact(describe(e))}` }], details: null, isError: true };", '            return { content: [{ type: "text", text: "没有找到相关的旧消息" }], details: null };']], [A2]],
  ["A3", "条数参数不校验上限", [[T, "x < 0 || x > COUNT_MAX)", "x < 0)"]], [A1]],
  ["A4", "检索带 before/after 不拒(两种用法混用)", [[T, '        if (v.before !== null || v.after !== null) return { ok: false, why: "检索不用 before/after,要读前后文请给 roomId 和 seq" };\n', ""]], [A1]],
];

const TIMEOUT_MS = Number(process.env.MUT_TIMEOUT_MS ?? 600_000);
function run(dir) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--test", "--test-concurrency=1", "--test-timeout=60000", "--test-force-exit", "--test-reporter=tap", ...TESTS], { cwd: dir, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let timedOut = false;
    child.stdout.on("data", (d) => {
      out += d;
    });
    child.stderr.on("data", () => {});
    const kill = () => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        /* 已退出 */
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, TIMEOUT_MS);
    child.on("close", (code) => {
      clearTimeout(timer);
      kill();
      // 被 --test-timeout 判掉的测试(testTimeoutFailure)单独标出,不算按名失败
      const lines = out.split("\n");
      const failed = [];
      const passed = [];
      for (let i = 0; i < lines.length; i++) {
        const m = /^(not ok|ok) \d+ - (.+?)(?: # .*)?$/.exec(lines[i]);
        if (!m) continue;
        if (m[1] === "ok") {
          passed.push(m[2]);
          continue;
        }
        let j = i + 1;
        while (j < lines.length && !/^(?:not )?ok \d+ - /.test(lines[j])) j++;
        failed.push({ name: m[2], timeout: /testTimeoutFailure|test timed out/.test(lines.slice(i + 1, j).join("\n")) });
      }
      resolve({ code, failed, passed, timedOut });
    });
  });
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "g4-hist-mut-"));
const pkgs = fs.readdirSync(path.join(ROOT, "packages"));
const copy = (name) => {
  const d = path.join(tmp, name);
  fs.cpSync(path.join(ROOT, "packages"), path.join(d, "packages"), { recursive: true, filter: (s) => !s.includes(`${path.sep}proof`) && !s.includes(`${path.sep}node_modules`) });
  for (const f of ["package.json", "tsconfig.json"]) fs.copyFileSync(path.join(ROOT, f), path.join(d, f));
  fs.mkdirSync(path.join(d, "node_modules", "@g-group"), { recursive: true });
  for (const e of fs.readdirSync(path.join(ROOT, "node_modules"))) {
    if (e === "@g-group" || e === ".bin" || e.startsWith(".")) continue;
    fs.symlinkSync(path.join(ROOT, "node_modules", e), path.join(d, "node_modules", e));
  }
  for (const p of pkgs) fs.symlinkSync(path.join("..", "..", "packages", p), path.join(d, "node_modules", "@g-group", p));
  return d;
};
const count = (s, sub) => s.split(sub).length - 1;
const only = process.env.MUT_ONLY ? new Set(process.env.MUT_ONLY.split(",")) : null;
const list = M.filter(([id]) => !only || only.has(id));

let ok = true;
console.log(`node ${process.version},变异 ${list.length} 个,测试文件 ${TESTS.length} 个`);
const clean = await run(copy("clean"));
const good = !clean.timedOut && clean.code === 0 && clean.failed.length === 0 && clean.passed.length > 0;
console.log(`${good ? "✓" : "✗"} 原样副本:${clean.passed.length} 绿 / ${clean.failed.length} 红${clean.failed.length ? `(${clean.failed.map((f) => f.name).join(";")})` : ""}`);
if (!good) ok = false;
const full = (prefix) => clean.passed.filter((n) => n.startsWith(prefix));
for (const [, , , killers] of list) {
  for (const k of killers) {
    if (full(k).length !== 1) {
      ok = false;
      console.log(`✗ 具名测试前缀「${k}」在原样副本里认出 ${full(k).length} 条通过的测试(要恰好 1 条)`);
    }
  }
}
let killed = 0;
let survived = 0;
for (const [i, [id, name, edits, killers]] of list.entries()) {
  const tag = `[${i + 1}/${list.length}] ${id}`;
  const d = copy(`m${i}`);
  let bad = null;
  for (const [file, from, to] of edits) {
    const f = path.join(d, file);
    const src = fs.readFileSync(f, "utf8");
    const n = count(src, from);
    if (n !== 1) {
      bad = `${file} 注入点出现 ${n} 次`;
      break;
    }
    fs.writeFileSync(f, src.replace(from, to));
  }
  if (bad) {
    ok = false;
    survived++;
    console.log(`✗ ${tag} ${name}:${bad},必须恰好 1 次`);
    fs.rmSync(d, { recursive: true, force: true });
    continue;
  }
  const t0 = Date.now();
  const r = await run(d);
  fs.rmSync(d, { recursive: true, force: true });
  const want = killers.flatMap(full);
  const byName = want.filter((n) => r.failed.some((f) => f.name === n && !f.timeout));
  const viaTimeout = want.filter((n) => r.failed.some((f) => f.name === n && f.timeout));
  const red = r.failed.map((f) => f.name).filter((n) => clean.passed.includes(n));
  const fileLevel = r.failed.filter((f) => TESTS.includes(f.name)).map((f) => f.name);
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const note = fileLevel.length ? `;另有文件级失败 ${fileLevel.join("、")}` : "";
  if (!r.timedOut && want.length > 0 && byName.length === want.length) {
    killed++;
    console.log(`✓ ${tag} ${name}:${r.passed.length} 绿 / ${r.failed.length} 红,用时 ${secs}s,指定测试按名失败:${byName.map((k) => `「${k.slice(0, 40)}」`).join("")};全部变红 ${red.length} 条${note}`);
  } else {
    ok = false;
    survived++;
    const why = r.timedOut ? "整组超时" : `指定测试没全部按名失败(按名 ${byName.length}/${want.length},超时 ${viaTimeout.length})`;
    console.log(`✗ ${tag} ${name}:${why},${r.passed.length} 绿 / ${r.failed.length} 红,用时 ${secs}s;变红:${red.map((k) => `「${k.slice(0, 40)}」`).join("")}${note}`);
  }
}
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`合计 ${list.length}:杀死 ${killed},存活 ${survived}`);
console.log(ok ? "变异校准通过" : "变异校准失败");
process.exit(ok ? 0 : 1);
