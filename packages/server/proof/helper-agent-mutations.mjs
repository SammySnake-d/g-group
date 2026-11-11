// Helper 运行时与软件操作工具(AC-52、U04/U05、D07.0)的行为变异校准(R-05 阳性埋雷):逐个注入单一故障,在隔离副本里跑本片的 4 个测试文件;
// 每个变异都必须让至少一条原样副本里通过的具名测试失败(文件级加载失败、超时不算),每处注入点必须恰好出现 1 次;原样副本必须全绿(阴性对照)。并发 1。
// 副本带整份 packages/(不含 proof),node_modules/@g-group/* 链到副本自己的包——跨包注入(内核、适配器)测的才是注入后的代码。
// 用法: node packages/server/proof/helper-agent-mutations.mjs
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const TESTS = ["packages/kernel/src/helper-ops.test.ts", "packages/adapter-pi-contact/src/helper-mind.test.ts", "packages/server/src/helper-agent.test.ts", "packages/server/src/task-import.test.ts"];
const K = "packages/kernel/src/helper-ops.ts";
const MCP = "packages/kernel/src/helper-mcp.ts";
const CSV = "packages/kernel/src/csv.ts";
const S = "packages/server/src/service.ts";
const H = "packages/server/src/helper-agent.ts";
const D = "packages/server/src/helper.ts";
const T = "packages/server/src/task-import.ts";
const IO = "packages/server/src/helper-mcp-stdio.ts";
const HO = "packages/server/src/host.ts";
const P = "packages/adapter-pi-contact/src/helper-mind.ts";
/** [名字, [[文件, 原文, 改成]...]] */
const M = [
  ["HM01 排除清单漏掉 messages.send(方法表对不上)", [[K, '    { method: "messages.send", reason: "Helper 不以用户身份在聊天里发言;@Helper 的回复以 helper 发言者出现" },\n', ""]]],
  ["HM02 不可逆类工具说明不标【先问用户】", [[K, '  return op.kind === "irreversible" ? `【先问用户】', '  return op.kind === "never" ? `【先问用户】']]],
  ["HM03 skill 不进系统提示", [[K, "input.skill.trim()].filter(Boolean)", '""].filter(Boolean)']]],
  ["HM04 MCP tools/call 不核对工具名(排除清单的方法也交给执行口)", [[MCP, 'if (typeof name !== "string" || !names.has(name)) {', 'if (typeof name !== "string") {']]],
  ["HM05 MCP tools/call 的 isError 取反", [[MCP, "isError: !r.ok", "isError: r.ok"]]],
  ["HM06 服务层不拒排除清单(Helper 身份能以用户身份发言、验收)", [[S, "    if (!HELPER_OPS.some((o) => o.method === method)) {", "    if (false) {"]]],
  ["HM07 服务层不按入口限读取范围(侧栏能读别的聊天、能从别的群带背景)", [[S, '    if (typeof reads === "string") helper.context(caller.entry, [reads], 1);', '    if (false) helper.context(caller.entry, [reads], 1);']]],
  ["HM08 侧栏 / @ 不限会话地搜消息", [[S, '    else if (method === "search.messages" && caller.entry.kind !== "global") throw', "    else if (false) throw"]]],
  ["HM09 全局入口把用户所在的全部会话带进模型输入", [[H, "    const cur = this.desk.context(entry, [], HELPER_CONTEXT_MESSAGES);", '    const cur = this.desk.context(entry, entry.kind === "global" ? this.host.roomsOfUser().map((r) => r.id) : [], HELPER_CONTEXT_MESSAGES);']]],
  ["HM10 侧栏回复同时发上公屏", [[H, '    else noteId = this.desk.note(entry, "helper", result.reply, `${cid}:a`).id;', '    else {\n      noteId = this.desk.note(entry, "helper", result.reply, `${cid}:a`).id;\n      if (entry.kind === "sidebar") this.host.send({ roomId: entry.roomId, clientActionId: `leak-${cid}`, text: result.reply });\n    }']]],
  ["HM11 用户 @Helper 时宿主不触发 Helper", [[H, "    if (host.helperMind)\n      host.bus.subscribe", "    if (false)\n      host.bus.subscribe"]]],
  ["HM12 联系人 @Helper 当成用户本人(不拒收)", [[H, '    const caller = { kind: m.sender.kind === "user" ? ("user" as const) : ("contact" as const), id: m.sender.id };', '    const caller = { kind: "user" as const, id: this.host.userId };']]],
  ["HM13 @Helper 的回复引错消息", [[D, "    return this.host.postAsHelper(entry.roomId, HELPER_ID, text, entry.seq, clientActionId);", "    return this.host.postAsHelper(entry.roomId, HELPER_ID, text, Math.max(0, entry.seq - 1), clientActionId);"]]],
  ["HM14 上下文清单不记(AC-52 观测点丢失)", [[H, "    ctx.seen.push(item);\n", ""]]],
  ["HM15 审计参数摘要不按规范化参数算", [[H, "createHash(\"sha256\").update(canonical({ method: op, args }))", "createHash(\"sha256\").update(JSON.stringify({ method: op, args }))"]]],
  ["HM16 Helper 不用全局默认说话模型", [[H, "    const model = this.host.settings().defaultSpeakingModel;", '    const model = "helper-own-model";']]],
  ["HM17 skill 不交给 Helper", [[H, "skill: helperSkill() },", 'skill: "" },']]],
  ["HM18 CSV 任务建到请求以外的群", [[T, "          roomId: room.id,\n", "          roomId: host.roomsOfUser().find((r) => r.id !== room.id)?.id ?? room.id,\n"]]],
  ["HM19 负责人列被忽略", [[T, "      owner = c.id;\n", ""]]],
  ["HM20 标题为空不逐行报错", [[T, "    if (!title) {", "    if (false) {"]]],
  ["HM21 引号里的换行当成记录结束", [[CSV, '        if (d === "\\n" || d === "\\r") line++;', '        if (d === "\\n" || d === "\\r") break;']]],
  ["HM22 空行不报错", [[CSV, '      errors.push({ line: r.line, reason: "空行" });\n', ""]]],
  ["HM23 缺列的行照样导入", [[CSV, "    if (r.fields.length < header.length) {", "    if (false) {"]]],
  ["HM24 \"\" 转义不还原成一个双引号", [[CSV, "            field += '\"';", "            field += '\"\"';"]]],
  ["HM25 pi:工具失败也当成功回填", [[P, "          r = { ok: got?.isError !== true, text };", "          r = { ok: true, text };"]]],
  ["HM26 pi:请求上限差一", [[P, "if (turn.toolResults.length > 0 && requests >= cfg.maxRequestsPerRound) {", "if (turn.toolResults.length > 0 && requests > cfg.maxRequestsPerRound) {"]]],
  ["HM27 pi:错误信息不隐去密钥", [[P, '  const redact = (s: string): string => s.split(cfg.apiKey).join("[密钥已隐去]");', "  const redact = (s: string): string => s;"]]],
  ["HM28 pi:工具声明不照 MCP tools/list 全发", [[P, "    const declarations = tools.map(", "    const declarations = tools.slice(1).map("]]],
  ["HM29 pi:模型不一致也照发", [[P, '  if (x.model !== model) throw new PiContactMindError("model-mismatch"', '  if (false) throw new PiContactMindError("model-mismatch"']]],
  ["HM30 建群背景消息写进原群", [[HO, "      const s = background !== null ? this.appendMessageTx(id, me, {", "      const s = background !== null ? this.appendMessageTx(opts.fromRoomId!, me, {"]]],
  ["HM31 建群不按 clientActionId 幂等", [[HO, "    if (prior) return this.roomView((JSON.parse(prior.payload) as { roomId: string }).roomId);\n", ""]]],
  ["HM33 模型中途失败时错误详情不带已执行的操作", [[H, ", { ops: ctx.ops, context: ctx.seen });", ");"]]],
  ["HM32 stdio:不是 JSON 的行不回 -32700", [[IO, '      send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });\n', ""]]],
];

// MUT_DRY=1:只核对每处注入点在原树里恰好出现 1 次,不跑测试
if (process.env.MUT_DRY) {
  let bad = 0;
  for (const [name, edits] of M)
    for (const [file, from] of edits) {
      const n = fs.readFileSync(path.join(ROOT, file), "utf8").split(from).length - 1;
      if (n !== 1) {
        bad++;
        console.log(`✗ ${name}:${file} 注入点出现 ${n} 次`);
      }
    }
  console.log(`注入点核对:${M.length} 个变异,${bad} 处不合格`);
  process.exit(bad ? 1 : 0);
}

const TIMEOUT_MS = Number(process.env.MUT_TIMEOUT_MS ?? 300_000);
function run(dir) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--test", "--test-concurrency=1", "--test-timeout=120000", "--test-force-exit", "--test-reporter=tap", ...TESTS], { cwd: dir, detached: true, stdio: ["ignore", "pipe", "pipe"] });
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
      const failed = [...out.matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1]);
      const passed = [...out.matchAll(/^ok \d+ - (.+)$/gm)].map((m) => m[1]);
      resolve({ code, failed, passed, timedOut });
    });
  });
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helper-agent-mut-"));
const pkgs = fs.readdirSync(path.join(ROOT, "packages"));
/** 副本:整份 packages/(不含 proof)+ node_modules(第三方链到原树,@g-group/* 链到副本自己的包) */
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

let ok = true;
console.log(`node ${process.version},变异 ${M.length} 个,测试文件 ${TESTS.length} 个`);
const clean = await run(copy("clean"));
const good = !clean.timedOut && clean.code === 0 && clean.failed.length === 0 && clean.passed.length > 0;
console.log(`${good ? "✓" : "✗"} 原样副本:${clean.passed.length} 绿 / ${clean.failed.length} 红${clean.failed.length ? `(${clean.failed.join(";")})` : ""}`);
if (!good) ok = false;
const named = new Set(clean.passed);
let killed = 0;
let survived = 0;
for (const [i, [name, edits]] of M.entries()) {
  const tag = `[${i + 1}/${M.length}]`;
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
    fs.writeFileSync(f, src.replace(from, () => to));
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
  const kills = r.failed.filter((t) => named.has(t));
  if (!r.timedOut && kills.length > 0) {
    killed++;
    console.log(`✓ ${tag} ${name}:${r.passed.length} 绿 / ${r.failed.length} 红,用时 ${((Date.now() - t0) / 1000).toFixed(1)}s,被发现:${kills.map((k) => `「${k}」`).join("")}`);
  } else {
    ok = false;
    survived++;
    console.log(`✗ ${tag} ${name}:${r.timedOut ? "超时" : `${r.passed.length} 绿 / ${r.failed.length} 红,存活(或只有文件级失败)`}`);
  }
}
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`合计 ${M.length}:杀死 ${killed},存活 ${survived}`);
console.log(ok ? "变异校准通过" : "变异校准失败");
process.exit(ok ? 0 : 1);
