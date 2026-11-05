// 行为变异校准(R-05 阳性埋雷):对 kernel 包的实现逐个注入单一故障(第二轮按 PR #6 审查 F-01..F-06 扩充,含审查存活的 M1=K14、M2=K15;第三轮按 RR-01..RR-05 与 AC-39 扩充,含 R2-M1=K51、R2-M2=K52,删掉方向反了的旧 K36;第四轮按 R3-01..R3-07 扩充,含 R3-M1=K86、R3-M2=K87,每个变异有超时),在隔离副本里跑本包测试,
// 每个变异都必须让至少一条具名测试失败(文件级加载失败不算杀死)。注入点必须在源码里恰好出现 1 次。
// 原样副本必须全绿(阴性对照)。
// 每个变异在独立进程组里跑,超时(默认 300s,KERNEL_MUT_TIMEOUT_MS 可改)就杀掉整个进程组,记 ✗ 超时,不算被杀死。
// 用法: node packages/kernel/proof/mutations.mjs
//       node packages/kernel/proof/mutations.mjs --canary-hang   注入一个必然卡住的变异,验证脚本能有界退出并把它记成超时
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PKG = path.resolve(import.meta.dirname, "..");
const ROOT = path.resolve(PKG, "../..");

const M = [
  // —— 插件注册(原 K01–K03,F-06 补的三类契约正负对照)
  ["K01 允许重复 id", "plugins.ts", 'if (plugins.has(r.snapshot.id)) return reject("duplicate-id", r.snapshot.id);', ""],
  ["K02 放行插件声明定时", "plugins.ts", 'if ("schedule" in c || "cron" in c) return { ok: false, reason: "schedule-not-allowed", detail: SCHEDULE_REASON };', ""],
  ["K03 放行插件互相依赖", "plugins.ts", 'if ("dependsOn" in c && !(Array.isArray(c.dependsOn) && c.dependsOn.length === 0)) return', "if (false) return"],
  ["K14 未声明源只拦 g2(审查 M1)", "plugins.ts", "if (!p.sources.includes(sourceId))", 'if (sourceId === "g2" && !p.sources.includes(sourceId))'],
  ["K15 OutboundChannel 不查 send(审查 M2)", "plugins.ts", 'if (typeof send !== "function") return', "if (false) return"],
  ["K16 DataSource 不查 sources", "plugins.ts", "if (!isStrList(c.sources) || c.sources.length === 0) return", "if (false) return"],
  ["K17 DataSource 不查 pull", "plugins.ts", 'if (typeof pull !== "function") return', "if (false) return"],
  ["K18 UIExtension 不查 mounts", "plugins.ts", "if (!isStrList(c.mounts)) return", "if (false) return"],
  ["K19 OutboundChannel 不查 idempotency", "plugins.ts", 'if (typeof c.idempotency !== "string" || !IDEMPOTENCY.has(c.idempotency)) return', "if (false) return"],
  // —— 宿主快照(F-03)
  ["K20 sources 不拷贝,共享调用方数组", "plugins.ts", "const sources = Object.freeze([...c.sources]);", "const sources = c.sources;"],
  ["K21 mounts 不拷贝,共享调用方数组", "plugins.ts", "mounts: Object.freeze([...c.mounts])", "mounts: c.mounts as string[]"],
  ["K22 注册表保存调用方原对象", "plugins.ts", 'return { ok: true, snapshot: Object.freeze({ kind: "data-source", id, sources, pull: (s: string) => pull.call(c, s) }) };', "return { ok: true, snapshot: c as unknown as Plugin };"],
  ["K23 reregister 允许换类型", "plugins.ts", "if (old.plugin.kind !== r.snapshot.kind) return", "if (false) return"],
  // —— 外部事件盖章(F-01)
  ["K10 外部内容不标不可信", "plugins.ts", '    trust: "untrusted",', '    trust: ((e as { trust?: string }).trust ?? "untrusted") as "untrusted",'],
  ["K24 丢弃源端版本", "plugins.ts", "    sourceVersion: e.sourceVersion,", '    sourceVersion: "",'],
  ["K25 丢弃事件类型", "plugins.ts", "    eventType: e.eventType as ExternalEventType,", '    eventType: "create" as ExternalEventType,'],
  ["K26 收到时间改用发生时间", "plugins.ts", "    receivedAt,", "    receivedAt: new Date(e.occurredAt).toISOString(),"],
  ["K27 丢弃附件引用", "plugins.ts", "    attachments: Object.freeze(attachments as AttachmentRef[]),", "    attachments: Object.freeze([]),"],
  ["K28 不校验事件类型枚举", "plugins.ts", 'if (typeof e.eventType !== "string" || !EVENT_TYPES.has(e.eventType)) return', "if (false) return"],
  // —— 外发(F-02)
  ["K11 发送不要求 action_id", "plugins.ts", 'if (!isStr(actionId)) return { ok: false, state: "rejected", reason: "missing-action-id"', 'if (false) return { ok: false, state: "rejected", reason: "missing-action-id"'],
  ["K12 同一 action_id 已确认仍重复真发", "plugins.ts", "if (prior.state === \"confirmed\" && prior.receipt) return", "if (false) return"],
  ["K29 B2 结果未知时盲重试", "plugins.ts", "if (b.idempotency === \"none\") return", "if (false) return"],
  ["K30 同步返回值当回执", "plugins.ts", "if (!isThenable(pending)) return unknown(", "if (false) return unknown("],
  ["K31 超时当成功", "plugins.ts", 'if (got === TIMEOUT) return unknown("timeout", ', 'if (got === TIMEOUT) got = { action_id: actionId, receiptId: "assumed" }; if (false) return unknown("timeout", '],
  ["K32 异步异常当成功", "plugins.ts", '    } catch (err) {\n      return unknown("send-threw", errText(err));', '    } catch {\n      got = { action_id: actionId, receiptId: "assumed" };'],
  ["K33 回执不校验 action_id", "plugins.ts", "if (!isObj(got) || got.action_id !== actionId || !isStr(got.receiptId)) return", "if (!isObj(got)) return"],
  ["K34 在途时允许再发", "plugins.ts", 'if (prior.state === "in-flight") return', "if (false) return"],
  ["K35 同 action_id 换内容复用旧回执", "plugins.ts", "if (b.payloadSha256 !== fingerprint) return", "if (false) return"],
  // —— 上下文装配(AC-06)
  ["K04 Page-in \u6539\u6210\u53d6\u6700\u8fd1 N \u6761", "assemble.ts", "const m = all.find((x) => x.seq === seq);", "const m = all.slice(-3).find((x) => x.seq === seq);"],
  ["K05 超预算静默截断", "assemble.ts", "if (need > opts.budgetBytes) return { ok: false, reason: \"over-budget\", need, budget: opts.budgetBytes, action: \"compress\" };", "while (final.length > 0 && final.reduce((a, s) => a + s.bytes, 0) > opts.budgetBytes) final.shift();"],
  ["K06 窗口内引用重复页入", "assemble.ts", "if (inHistory.has(seq) || paged.some((p) => p.seq === seq)) continue;", "if (paged.some((p) => p.seq === seq)) continue;"],
  ["K07a 撤回消息被引用时仍页入", "assemble.ts", 'if (m.retracted) { skipped.push({ seq, reason: "retracted" }); continue; }', ""],
  ["K07b \u64a4\u56de\u6d88\u606f\u8fdb\u7a97\u53e3", "assemble.ts", "      if (retracted.has(e.seq)) continue;\n", ""],
  // —— 分类(AC-11 / AC-12,F-04 / F-05)
  ["K08 \u6709\u673a\u68b0\u951a\u70b9\u4e5f\u8c03\u5206\u7c7b\u5668", "classify.ts", "const { invalidMentions, ...anchors } = anchorsOf(event);", "const { invalidMentions, ...anchors } = anchorsOf(event);\n  try { classifier(event); } catch { /* \u53d8\u5f02:\u591a\u8c03\u4e00\u6b21 */ }"],
  ["K09 分类器自由文本被放行", "classify.ts", 'if (typeof raw === "string" && ALLOWED.has(raw))', 'if (typeof raw === "string")'],
  ["K13 确认卡版本号不算机械线索", "classify.ts", "if (anchors.card !== undefined) {", "if (false) {"],
  ["K37 诊断不防循环引用", "classify.ts", 'if (seen.has(v)) return "[循环]"; seen.add(v);', "seen.add(v);"],
  ["K38 诊断序列化失败直接抛出(审查 F-04 原错)", "classify.ts", "  } catch (err) {\n    let tag", "  } catch (err) {\n    throw err;\n    let tag"],
  ["K39 诊断不处理嵌套 BigInt", "classify.ts", 'if (typeof v === "bigint") return `${v}n`;', ""],
  ["K40 确认卡不校验回复者是用户", "classify.ts", 'if (e.sender?.kind !== "user") return', "if (false) return"],
  ["K41 确认卡不校验版本", "classify.ts", "if (!Number.isInteger(c.version) || c.version < 1) return", "if (false) return"],
  ["K42 确认卡不校验决定枚举", "classify.ts", 'if (typeof c.decision !== "string" || !DECISIONS.has(c.decision)) return', "if (false) return"],
  ["K43 带 @ 带文字也机械判 E1(审查 F-05 原错)", "classify.ts", "if (mentionOnly(event, { ...anchors, invalidMentions })) return", "if (anchors.mentions.length > 0) return"],
  ["K44 带引用也机械判 E1", "classify.ts", "if (mentionOnly(event, { ...anchors, invalidMentions })) return", "if (mentionOnly(event, { ...anchors, invalidMentions }) || anchors.quotes.length > 0) return"],
  // —— 第三轮:RR-01..RR-05
  ["K71 已确认 B1 过保留期后重发(RR-01 原错)", "plugins.ts", "if (prior.state === \"confirmed\" && prior.receipt) return", "if (prior.state === \"confirmed\" && prior.receipt && now() - b.firstAttemptAt < b.windowMs) return"],
  ["K55 未知 B1 不查保留期(RR-01 原错)", "plugins.ts", "if (now() - b.firstAttemptAt >= b.windowMs) return", "if (false) return"],
  ["K56 恰到期仍放行重试", "plugins.ts", "now() - b.firstAttemptAt >= b.windowMs", "now() - b.firstAttemptAt > b.windowMs"],
  ["K57 重试刷新首次尝试时间", "plugins.ts", "entry.attempts++;", "entry.attempts++;\n    entry.binding = { ...entry.binding, firstAttemptAt: now() };"],
  ["K54 \u672a\u77e5\u52a8\u4f5c\u4e0d\u67e5\u6e20\u9053\u7248\u672c(RR-02 \u539f\u9519)", "plugins.ts", "if (reg.version !== b.channelVersion || p.endpoint !== b.endpoint) return", "if (p.endpoint !== b.endpoint) return"],
  ["K58 未知动作按当前渠道判 B2(RR-02 原错)", "plugins.ts", "if (b.idempotency === \"none\") return", "if (p.idempotency === \"none\") return"],
  ["K59 B1 不要求保留期", "plugins.ts", "if (idempotency === \"action-id\" && !(typeof w === \"number\" && Number.isFinite(w) && w > 0)) return", "if (false) return"],
  ["K60 载荷不查字符串", "plugins.ts", "if (typeof payload !== \"string\") return", "if (false) return"],
  ["K51 载荷比对前去空白(审查 R2-M1)", "plugins.ts", "const payload = req.payload;", "const payload = typeof req.payload === \"string\" ? req.payload.trim() : req.payload;"],
  ["K52 不查 author 类型(审查 R2-M2)", "plugins.ts", "if (typeof e.author !== \"string\") return \"缺 author\";", ""],
  ["K53 不查 content 类型", "plugins.ts", "if (typeof e.content !== \"string\") return \"content 必须是字符串\";", ""],
  ["K45 纯点名用宽泛正则去名字(RR-03 原错)", "classify.ts", "return rest.trim() === \"\";", "return e.text.replace(/@\\S+/g, \"\").trim() === \"\";"],
  ["K46 点名不查名字里的标点", "classify.ts", "NAME_FORBIDDEN.test(name)", "false"],
  ["K47 点名不查范围与正文对得上", "classify.ts", "return text.slice(start as number, end as number) === `@${name}`;", "return true;"],
  ["K50 异常兜底直接读 message(RR-04 原错)", "classify.ts", "try {\n    if (err instanceof Error) return safeDescribe(err.message);\n  } catch { /* 读取失败,退回整体描述 */ }", "if (err instanceof Error) return safeDescribe(err.message);"],
  // —— AC-39 / D22 前缀纪律
  ["K61 stable 段不扫会变内容(system 注入时间)", "assemble.ts", "for (const [name, re] of VOLATILE_PATTERNS) {", "for (const [name, re] of []) {"],
  ["K62 stable 段放行最近 N 条", "assemble.ts", "  [\"最近 N 条\", /最近\\s*\\d+\\s*条/],", ""],
  ["K64 \u6bcf\u8f6e\u91cd\u622a\u6700\u8fd1 N \u6761", "assemble.ts", "if (e.seq <= through) continue;", "if (e.seq <= through || e.seq < head - 2) continue;"],
  ["K65 Page-in 插进前缀", "assemble.ts", "for (const m of paged) segments.push(seg(\"tail\", \"page-in\",", "for (const m of paged) segments.splice(opts.stable.length, 0, seg(\"history\", \"page-in\","],
  ["K70 会变状态放进 stable", "assemble.ts", "segments.push(seg(\"tail\", \"volatile\",", "segments.splice(opts.stable.length, 0, seg(\"stable\", \"volatile\","],
  ["K66 \u65ad\u70b9\u8d85\u8fc7 4 \u4e2a", "assemble.ts", "lastOf((s) => s.section === \"history\" && s.label !== \"compressed\"),", "lastOf((s) => s.section === \"history\" && s.label !== \"compressed\"),\n    lastOf((s) => s.section === \"tail\"),\n    0,"],
  ["K67 \u65ad\u70b9\u653e\u8fdb tail", "assemble.ts", "lastOf((s) => s.section === \"history\" && s.label !== \"compressed\"),", "lastOf((s) => s.section !== \"stable\" && s.label !== \"compressed\"),"],
  ["K68 前缀哈希把 tail 算进去", "assemble.ts", "section !== \"tail\")", "section !== \"never\")"],
  ["K69 前缀哈希不按字节截", "assemble.ts", "subarray(0, bytes)", "subarray(0)"],
  // —— 第四轮:R3-01..R3-06
  ["K63 stable \u6bb5\u62ff\u4f1a\u8bdd\u6d88\u606f\u6bd4\u5bf9(R3-04 \u539f\u9519)", "assemble.ts", "const hit = volatileIn(part.text);", "const hit = volatileIn(part.text) ?? (log.events.some((e) => e.body.kind === \"message\" && e.body.text.length >= 4 && part.text.includes(e.body.text)) ? \"\u6d88\u606f\u539f\u6587\" : undefined);"],
  ["K72 send \u7528\u8c03\u7528\u65b9\u539f\u5bf9\u8c61\u4e3a this(R3-03 \u539f\u9519)", "plugins.ts", "send: (r: { action_id: string; payload: string }) => send.call(self, r)", "send: (r: { action_id: string; payload: string }) => send.call(c, r)"],
  ["K73 \u64a4\u56de\u4e0d\u4f5c\u5e9f\u538b\u7f29\u5757(R3-01 \u539f\u9519)", "assemble.ts", "if (stale.length > 0) {", "if (false) {"],
  ["K74 \u4e0d\u626b\u538b\u7f29\u5757\u91cc\u7684\u64a4\u56de\u539f\u6587", "assemble.ts", "    if (leaked !== undefined) return { ok: false, reason: \"retracted-text-leaked\", where: \"compressed\", seq: leaked };\n", ""],
  ["K75 \u4e0d\u626b\u4f1a\u53d8\u72b6\u6001\u91cc\u7684\u64a4\u56de\u539f\u6587", "assemble.ts", "    if (leaked !== undefined) return { ok: false, reason: \"retracted-text-leaked\", where: \"volatile\", seq: leaked };\n", ""],
  ["K76 \u91cd\u5efa\u538b\u7f29\u5757\u65f6\u4ea4\u51fa\u64a4\u56de\u6d88\u606f", "assemble.ts", "const visible = all.filter((m) => m.seq <= b.throughSeq && !m.retracted);", "const visible = all.filter((m) => m.seq <= b.throughSeq);"],
  ["K77 history \u64a4\u56de\u4e0d\u6807 prefixBreak", "assemble.ts", "if (target > through && isNew(rs)) prefixBreaks.push", "if (false) prefixBreaks.push"],
  ["K78 \u540c\u4e00\u64a4\u56de\u6bcf\u8f6e\u91cd\u590d\u62a5 prefixBreak", "assemble.ts", "const isNew = (retractSeq: number) => opts.previousHeadSeq === undefined || retractSeq > opts.previousHeadSeq;", "const isNew = (_retractSeq: number) => true;"],
  ["K79 \u64a4\u56de\u540e\u7684\u7f16\u8f91\u6587\u5b57\u4ecd\u8fdb history", "assemble.ts", "      if (retracted.has(b.target)) continue;\n", ""],
  ["K80 \u7f16\u8f91\u539f\u5730\u6539\u5199\u65e7\u6d88\u606f(R3-02 \u539f\u9519)", "assemble.ts", "segments.push(seg(\"history\", \"message\", `#${e.seq} ${who(e)}: ${b.text}\\n`, { seq: e.seq }));", "segments.push(seg(\"history\", \"message\", `#${e.seq} ${who(e)}: ${all.find((m) => m.seq === e.seq)?.text ?? b.text}\\n`, { seq: e.seq }));"],
  ["K81 \u7f16\u8f91\u4e8b\u4ef6\u88ab\u4e22\u6389(R3-02 \u539f\u9519)", "assemble.ts", "segments.push(seg(\"history\", \"edit\",", "if (false) segments.push(seg(\"history\", \"edit\","],
  ["K82 \u4e0d\u6821\u9a8c\u56fa\u5b9a\u6bb5\u987a\u5e8f(R3-05 \u539f\u9519)", "assemble.ts", "if (i < last) return", "if (false) return"],
  ["K83 \u4e0d\u6821\u9a8c\u56fa\u5b9a\u6bb5\u91cd\u590d", "assemble.ts", "if (seen.has(p.kind)) return", "if (false) return"],
  ["K84 \u4e0d\u6821\u9a8c\u751f\u6210\u70b9\u8303\u56f4", "assemble.ts", "if (c.builtAtSeq < c.throughSeq || c.builtAtSeq > head) return", "if (false) return"],
  ["K85 \u538b\u7f29\u70b9\u4e0d\u67e5\u975e\u8d1f\u6574\u6570(R3-05 \u539f\u9519)", "assemble.ts", "if (!isNat(c.throughSeq)) return", "if (false) return"],
  ["K86 helper \u6d88\u606f\u4e0d\u8fdb history(\u5ba1\u67e5 R3-M1)", "assemble.ts", "    if (b.kind === \"message\") {\n", "    if (b.kind === \"message\" && e.sender.kind !== \"helper\") {\n"],
  ["K87 \u4f1a\u53d8\u72b6\u6001\u88ab\u6362\u6210\u56fa\u5b9a\u5b57(\u5ba1\u67e5 R3-M2)", "assemble.ts", "`[\u5f53\u524d\u72b6\u6001]\\n${opts.volatile}\\n`", "`[\u5f53\u524d\u72b6\u6001]\\n\u65e0\\n`"],
  ["K88 \u4e0d\u8981\u6c42 endpoint", "plugins.ts", "if (!isStr(c.endpoint)) return", "if (false) return"],
  ["K89 \u4e0d\u5feb\u7167\u914d\u7f6e", "plugins.ts", "if (!self) return", "if (false) return"],
];

const TIMEOUT_MS = Number(process.env.KERNEL_MUT_TIMEOUT_MS ?? 300_000);
const CANARY = process.argv.includes("--canary-hang");

/** 跑一个副本的全部测试;超时杀掉整个进程组,返回 timedOut。 */
function run(dir, timeoutMs = TIMEOUT_MS) {
  const files = fs.readdirSync(path.join(dir, "src")).filter((f) => f.endsWith(".test.ts")).map((f) => path.join("src", f));
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--test", "--test-reporter=tap", ...files], { cwd: dir, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let timedOut = false;
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", () => {});
    const kill = () => { try { process.kill(-child.pid, "SIGKILL"); } catch { /* 已退出 */ } };
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      kill(); // 回收可能残留的孙进程
      const failed = [...out.matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1]);
      const passed = [...out.matchAll(/^ok \d+ - (.+)$/gm)].map((m) => m[1]);
      resolve({ code, failed, passed, timedOut });
    });
  });
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kernel-mut-"));
const copy = (name) => {
  const d = path.join(tmp, name);
  fs.cpSync(PKG, d, { recursive: true, filter: (s) => !s.includes(`${path.sep}proof`) });
  fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(d, "node_modules"));
  return d;
};
const count = (s, sub) => s.split(sub).length - 1;
const secs = (ms) => `${(ms / 1000).toFixed(1)}s`;

async function main() {
  console.log(`node ${process.version},每个变异超时 ${secs(TIMEOUT_MS)}`);
  if (CANARY) {
    const d = copy("canary");
    const f = path.join(d, "src", "assemble.ts");
    const marker = "export function assemble(log: Log, opts: AssembleOptions): AssembleResult {";
    fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace(marker, `${marker}\n  for (;;) { /* 金丝雀:必然卡住 */ }`));
    const t0 = Date.now();
    const r = await run(d, Number(process.env.KERNEL_MUT_TIMEOUT_MS ?? 5_000));
    fs.rmSync(tmp, { recursive: true, force: true });
    const good = r.timedOut;
    console.log(`${good ? "✓" : "✗"} 金丝雀(必然卡住的变异):${r.timedOut ? `超时被杀,用时 ${secs(Date.now() - t0)},记 ✗ 超时、不算杀死` : "没有超时,脚本超时机制失效"}`);
    process.exit(good ? 0 : 1);
  }
  let ok = true;
  const clean = await run(copy("clean"));
  const named = new Set(clean.passed);
  const cleanOk = !clean.timedOut && clean.code === 0 && clean.failed.length === 0 && clean.passed.length > 0;
  console.log(`${cleanOk ? "✓" : "✗"} 原样副本:${clean.passed.length} 绿 / ${clean.failed.length} 红${clean.timedOut ? ",超时" : ""}`);
  if (!cleanOk) ok = false;
  let killedN = 0, survived = 0, timeouts = 0;
  for (const [i, [name, file, from, to]] of M.entries()) {
    const tag = `[${i + 1}/${M.length}]`;
    const d = copy(`m${i}`);
    const f = path.join(d, "src", file);
    const src = fs.readFileSync(f, "utf8");
    const n = count(src, from);
    if (n !== 1) { ok = false; survived++; console.log(`✗ ${tag} ${name}:注入点出现 ${n} 次,必须恰好 1 次(实现已变,更新本脚本)`); continue; }
    fs.writeFileSync(f, src.replace(from, to));
    const t0 = Date.now();
    const r = await run(d);
    fs.rmSync(d, { recursive: true, force: true });
    // 只有原样副本里通过的具名测试变红才算杀死;文件级失败、超时都不算
    const kills = r.failed.filter((t) => named.has(t));
    if (r.timedOut) {
      ok = false; timeouts++;
      console.log(`✗ ${tag} ${name}:超时 ${secs(TIMEOUT_MS)} 被强制结束,不算杀死(超时前 ${r.passed.length} 绿 / ${r.failed.length} 红)`);
    } else if (kills.length > 0) {
      killedN++;
      console.log(`✓ ${tag} ${name}:${r.passed.length} 绿 / ${r.failed.length} 红,用时 ${secs(Date.now() - t0)},被「${kills[0]}」发现`);
    } else {
      ok = false; survived++;
      console.log(`✗ ${tag} ${name}:${r.passed.length} 绿 / ${r.failed.length} 红,存活(或只有文件级失败)`);
    }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`合计 ${M.length}:杀死 ${killedN},存活 ${survived},超时 ${timeouts}`);
  console.log(ok ? "变异校准通过" : "变异校准失败");
  process.exit(ok ? 0 : 1);
}
await main();
