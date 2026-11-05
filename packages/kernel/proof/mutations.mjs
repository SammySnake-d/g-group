// 行为变异校准(R-05 阳性埋雷):对 kernel 包的实现逐个注入单一故障(第二轮按 PR #6 审查 F-01..F-06 扩充,含审查存活的 M1=K14、M2=K15),在隔离副本里跑本包测试,
// 每个变异都必须让至少一条具名测试失败(文件级加载失败不算杀死)。注入点必须在源码里恰好出现 1 次。
// 原样副本必须全绿(阴性对照)。
// 用法: node packages/kernel/proof/mutations.mjs
import { spawnSync } from "node:child_process";
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
  ["K23 reregister 允许换类型", "plugins.ts", "if (old.kind !== r.snapshot.kind) return", "if (false) return"],
  // —— 外部事件盖章(F-01)
  ["K10 外部内容不标不可信", "plugins.ts", '    trust: "untrusted",', '    trust: ((e as { trust?: string }).trust ?? "untrusted") as "untrusted",'],
  ["K24 丢弃源端版本", "plugins.ts", "    sourceVersion: e.sourceVersion,", '    sourceVersion: "",'],
  ["K25 丢弃事件类型", "plugins.ts", "    eventType: e.eventType as ExternalEventType,", '    eventType: "create" as ExternalEventType,'],
  ["K26 收到时间改用发生时间", "plugins.ts", "    receivedAt,", "    receivedAt: new Date(e.occurredAt).toISOString(),"],
  ["K27 丢弃附件引用", "plugins.ts", "    attachments: Object.freeze(attachments as AttachmentRef[]),", "    attachments: Object.freeze([]),"],
  ["K28 不校验事件类型枚举", "plugins.ts", 'if (typeof e.eventType !== "string" || !EVENT_TYPES.has(e.eventType)) return', "if (false) return"],
  // —— 外发(F-02)
  ["K11 发送不要求 action_id", "plugins.ts", 'if (!isStr(actionId)) return { ok: false, state: "rejected", reason: "missing-action-id"', 'if (false) return { ok: false, state: "rejected", reason: "missing-action-id"'],
  ["K12 同一 action_id 已确认仍重复真发", "plugins.ts", 'if (p.idempotency === "none" || now() - prior.at <= receiptTtlMs) return', "if (false) return"],
  ["K29 B2 结果未知时盲重试", "plugins.ts", 'if (p.idempotency === "none") return { ok: false, state: "delivery-unknown", reason: "retry-refused"', 'if (false) return { ok: false, state: "delivery-unknown", reason: "retry-refused"'],
  ["K30 同步返回值当回执", "plugins.ts", "if (!isThenable(pending)) return unknown(", "if (false) return unknown("],
  ["K31 超时当成功", "plugins.ts", 'if (got === TIMEOUT) return unknown("timeout", ', 'if (got === TIMEOUT) got = { action_id: actionId, receiptId: "assumed" }; if (false) return unknown("timeout", '],
  ["K32 异步异常当成功", "plugins.ts", '    } catch (err) {\n      return unknown("send-threw", errText(err));', '    } catch {\n      got = { action_id: actionId, receiptId: "assumed" };'],
  ["K33 回执不校验 action_id", "plugins.ts", "if (!isObj(got) || got.action_id !== actionId || !isStr(got.receiptId)) return", "if (!isObj(got)) return"],
  ["K34 在途时允许再发", "plugins.ts", 'if (prior.state === "in-flight") return', "if (false) return"],
  ["K35 同 action_id 换内容复用旧回执", "plugins.ts", "if (prior.payload !== payload) return", "if (false) return"],
  ["K36 B1 回执过期仍复用", "plugins.ts", "now() - prior.at <= receiptTtlMs", "true"],
  // —— 上下文装配(AC-06)
  ["K04 Page-in 改成取最近 N 条", "assemble.ts", "return all.find((m) => m.seq === seq);", "return all.slice(-3).find((m) => m.seq === seq);"],
  ["K05 超预算静默截断", "assemble.ts", 'if (need > opts.budgetBytes) return { ok: false, reason: "over-budget", need, budget: opts.budgetBytes };', "while (chunks.length > 0 && chunks.reduce((a, c) => a + c.entry.bytes, 0) > opts.budgetBytes) chunks.shift();"],
  ["K06 窗口内引用重复页入", "assemble.ts", "if (inWindow.has(seq) || paged.some((p) => p.seq === seq)) continue;", "if (paged.some((p) => p.seq === seq)) continue;"],
  ["K07a 撤回消息被引用时仍页入", "assemble.ts", 'if (m.retracted) { skipped.push({ seq, reason: "retracted" }); continue; }', ""],
  ["K07b 撤回消息进窗口", "assemble.ts", "const visible = all.filter((m) => !m.retracted);", "const visible = all;"],
  // —— 分类(AC-11 / AC-12,F-04 / F-05)
  ["K08 有机械锚点也调分类器", "classify.ts", "const anchors = anchorsOf(event);", "const anchors = anchorsOf(event);\n  classifier(event);"],
  ["K09 分类器自由文本被放行", "classify.ts", 'if (typeof raw === "string" && ALLOWED.has(raw))', 'if (typeof raw === "string")'],
  ["K13 确认卡版本号不算机械线索", "classify.ts", "if (anchors.card !== undefined) {", "if (false) {"],
  ["K37 诊断不防循环引用", "classify.ts", 'if (seen.has(v)) return "[循环]"; seen.add(v);', "seen.add(v);"],
  ["K38 诊断序列化失败直接抛出(审查 F-04 原错)", "classify.ts", "  } catch (err) {\n    let tag", "  } catch (err) {\n    throw err;\n    let tag"],
  ["K39 诊断不处理嵌套 BigInt", "classify.ts", 'if (typeof v === "bigint") return `${v}n`;', ""],
  ["K40 确认卡不校验回复者是用户", "classify.ts", 'if (e.sender?.kind !== "user") return', "if (false) return"],
  ["K41 确认卡不校验版本", "classify.ts", "if (!Number.isInteger(c.version) || c.version < 1) return", "if (false) return"],
  ["K42 确认卡不校验决定枚举", "classify.ts", 'if (typeof c.decision !== "string" || !DECISIONS.has(c.decision)) return', "if (false) return"],
  ["K43 带 @ 带文字也机械判 E1(审查 F-05 原错)", "classify.ts", "if (mentionOnly(event, anchors))", "if (anchors.mentions.length > 0)"],
  ["K44 带引用也机械判 E1", "classify.ts", "if (mentionOnly(event, anchors))", "if (mentionOnly(event, anchors) || anchors.quotes.length > 0)"],
];

function run(dir) {
  const files = fs.readdirSync(path.join(dir, "src")).filter((f) => f.endsWith(".test.ts")).map((f) => path.join("src", f));
  const r = spawnSync(process.execPath, ["--test", "--test-reporter=tap", ...files], { cwd: dir, encoding: "utf8" });
  const out = r.stdout ?? "";
  const failed = [...out.matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1]);
  const passed = [...out.matchAll(/^ok \d+ - (.+)$/gm)].map((m) => m[1]);
  return { code: r.status, failed, passed };
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kernel-mut-"));
const copy = (name) => {
  const d = path.join(tmp, name);
  fs.cpSync(PKG, d, { recursive: true, filter: (s) => !s.includes(`${path.sep}proof`) });
  fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(d, "node_modules"));
  return d;
};
const count = (s, sub) => s.split(sub).length - 1;
let ok = true;
const clean = run(copy("clean"));
const named = new Set(clean.passed);
console.log(`${clean.code === 0 && clean.failed.length === 0 ? "✓" : "✗"} 原样副本:${clean.passed.length} 绿 / ${clean.failed.length} 红`);
if (clean.code !== 0 || clean.failed.length > 0 || clean.passed.length === 0) ok = false;
M.forEach(([name, file, from, to], i) => {
  const d = copy(`m${i}`);
  const f = path.join(d, "src", file);
  const src = fs.readFileSync(f, "utf8");
  const n = count(src, from);
  if (n !== 1) { ok = false; console.log(`✗ ${name}:注入点出现 ${n} 次,必须恰好 1 次(实现已变,更新本脚本)`); return; }
  fs.writeFileSync(f, src.replace(from, to));
  const r = run(d);
  // 只有原样副本里通过的具名测试变红才算杀死;文件级失败(测试名是文件路径或不在名单里)不算
  const kills = r.failed.filter((t) => named.has(t));
  const killed = kills.length > 0;
  if (!killed) ok = false;
  console.log(`${killed ? "✓" : "✗"} ${name}:${r.passed.length} 绿 / ${r.failed.length} 红${killed ? `,被「${kills[0]}」发现` : ",存活(或只有文件级失败)"}`);
});
fs.rmSync(tmp, { recursive: true, force: true });
console.log(ok ? "变异校准通过" : "变异校准失败");
process.exit(ok ? 0 : 1);
