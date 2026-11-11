// AC-10 行为变异校准(R-05 阳性埋雷):对租约原语 lease.ts、反例回放 trace-replay.ts 与 CAS 原语 cas.ts 逐个注入单一故障,
// 在隔离副本里只跑 lease.test.ts 与 trace-replay.test.ts,每个变异都必须让至少一条具名测试失败;原样副本必须全绿(阴性对照)。
// T01/T02 就是验收文档 AC-10 的埋雷「去掉 CAS 版本校验」:TLC 侧由 tla/*-nocas.cfg 出反例,代码侧由回归用例变红。
// 不列入的等价变异:acquireLease 里 commitIn 的期望版本改成 cur.ver(前一行已判定两者相等);
// replayPublish 记录 over 改成 base(真实提交成功时两者必然相等)。
// 用法: node packages/domain/proof/tla-mutations.mjs
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PKG = path.resolve(import.meta.dirname, "..");
const ROOT = path.resolve(PKG, "../..");
const TESTS = ["src/lease.test.ts", "src/trace-replay.test.ts"];

const M = [
  ["T01 commit 去掉版本校验(AC-10 埋雷:去掉 CAS)", "cas.ts", 'if (cur.ver !== expectedVer) return { ok: false, reason: "version-conflict", currentVer: cur.ver };', ""],
  ["T02 commitIn 去掉版本校验(AC-10 埋雷:去掉 CAS)", "cas.ts", 'if (curVer !== expectedVer) return { ok: false, reason: "version-conflict", currentVer: curVer };', ""],
  ["L01 去掉全序检查(逆序申请放行)", "lease.ts", '  if (heldRank >= req.rank) return { ok: false, reason: "reverse-order", rank: req.rank, heldRank };\n', ""],
  ["L02 同序资源放行(>= 改 >)", "lease.ts", "if (heldRank >= req.rank)", "if (heldRank > req.rank)"],
  ["L03 申请不比快照版本", "lease.ts", '  if (cur.ver !== req.expectedVer) return { ok: false, reason: "version-conflict", currentVer: cur.ver };\n', ""],
  ["L04 不查占用(覆盖别人的租约)", "lease.ts", '  if (cur.holder !== null) return { ok: false, reason: "held-by-other", holder: cur.holder };\n', ""],
  ["L05 授予 epoch 不加一", "lease.ts", "const epoch = cur.epoch + 1;", "const epoch = cur.epoch;"],
  ["L06 释放不核对 epoch(旧令牌能释放新租约)", "lease.ts", '  if (cur.epoch !== req.epoch) return { ok: false, reason: "stale-epoch", epoch: cur.epoch };\n', ""],
  ["L07 释放不核对持有者", "lease.ts", '  if (cur.holder !== req.holder) return { ok: false, reason: "not-holder", holder: cur.holder };\n', ""],
  ["L08 释放后不清持有者", "lease.ts", "{ holder: null, epoch: cur.epoch }", "{ holder: req.holder, epoch: cur.epoch }"],
  ["L09 不校验已持有序号", "lease.ts", '  if (!Array.isArray(req.heldRanks) || !req.heldRanks.every(isNat)) return { ok: false, reason: "invalid-request", detail: "heldRanks 必须是非负整数数组" };\n', ""],
  ["L10 读快照时持有者一律当空闲", "lease.ts", "holder: c?.value.holder ?? null,", "holder: null,"],
  ["L11 最高序号初值改成 0(空手也不许申请序号 0)", "lease.ts", "return heldRanks.reduce((m, r) => Math.max(m, r), -1);", "return heldRanks.reduce((m, r) => Math.max(m, r), 0);"],
  ["R01 模型 conflict 当成 ok", "trace-replay.ts", 'op === "conflict" ? "conflict" : ', ""],
  ["R02 发布回放用当前版本提交(不带读到的版本)", "trace-replay.ts", "const r = commitIn(store, ROOM, b, `${who} 基于 v${b} 的草稿`);", "const r = commitIn(store, ROOM, verNow(), `${who} 基于 v${b} 的草稿`);"],
  ["R03 认领回放读最新版本而不是读到的快照", "trace-replay.ts", "const snap = seen.get(who) ?? cur;", "const snap = cur;"],
  ["R04 认领回放不经状态机直接提交", "trace-replay.ts", "      if (!out.ok) {\n        steps.push({ index, op, who, model: modelVerdict(op), real: \"rejected\", reason: out.reason });\n        continue;\n      }\n      const r = commit(cur, snap.ver, out.task);", "      const r = commit(cur, snap.ver, out.ok ? out.task : snap.value);"],
  ["R05 租约回放不带已持有序号", "trace-replay.ts", "heldRanks: [...mine.keys()].map((x) => order.indexOf(x))", "heldRanks: []"],
  ["R06 租约回放把拒绝都记成冲突", "trace-replay.ts", 'real: r.ok ? "ok" : r.reason === "version-conflict" ? "conflict" : "rejected"', 'real: r.ok ? "ok" : "conflict"'],
  ["R07 释放回放不带授予时的 epoch", "trace-replay.ts", "releaseLease(table, { resource: res, holder: who, epoch })", "releaseLease(table, { resource: res, holder: who, epoch: 0 })"],
  ["R08 分歧点恒为 null", "trace-replay.ts", "return steps.find((s) => s.model !== s.real) ?? null;", "return null;"],
  ["R09 回放不跳过初始状态", "trace-replay.ts", "    .filter((s) => s.index > 1)\n", ""],
  ["R10 不校验 TLC 输出外形", "trace-replay.ts", '  if (!isRec(dump) || !isRec(dump.counterexample) || !Array.isArray(dump.counterexample.state)) throw new TypeError("不是 TLC -dumpTrace json 的输出");\n', ""],
  ["R11 认领回放不记成功者", "trace-replay.ts", "        winners.push(who);\n", ""],
  ["R12 发布回放提交成功不推进存储", "trace-replay.ts", "      if (r.ok) {\n        store = r.store;\n        published.push({ who, base: b, over });", "      if (r.ok) {\n        published.push({ who, base: b, over });"],
];

function run(dir) {
  const r = spawnSync(process.execPath, ["--test", "--test-concurrency=1", "--test-reporter=tap", ...TESTS], { cwd: dir, encoding: "utf8" });
  // 文件级失败(加载或语法错误)的条目名就是测试文件路径,不算具名测试被杀死
  const failed = [...(r.stdout ?? "").matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1]).filter((n) => !/\.test\.ts$/.test(n));
  const passed = [...(r.stdout ?? "").matchAll(/^ok \d+ - (.+)$/gm)].map((m) => m[1]);
  return { code: r.status, failed, passed };
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tla-mut-"));
const copy = (name) => {
  const d = path.join(tmp, name);
  fs.cpSync(PKG, d, { recursive: true, filter: (s) => !s.includes(`${path.sep}proof`) });
  fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(d, "node_modules"));
  return d;
};
let ok = true;
const seen = new Map();
for (const [name, file, from, to] of M) {
  const k = JSON.stringify([file, from, to]);
  if (seen.has(k)) { ok = false; console.log(`✗ ${name}:与 ${seen.get(k)} 是同一注入,不能重复计数`); }
  else seen.set(k, name);
}
console.log(`共 ${M.length} 个变异,${seen.size} 种不同注入`);
const clean = run(copy("clean"));
console.log(`${clean.code === 0 && clean.failed.length === 0 ? "✓" : "✗"} 原样副本:${clean.passed.length} 绿 / ${clean.failed.length} 红`);
if (clean.code !== 0 || clean.failed.length) ok = false;
M.forEach(([name, file, from, to], i) => {
  const d = copy(`m${i}`);
  const f = path.join(d, "src", file);
  const src = fs.readFileSync(f, "utf8");
  const hits = src.split(from).length - 1;
  if (hits !== 1) { ok = false; console.log(`✗ ${name}:注入点出现 ${hits} 次,必须恰好 1 次(实现已变,更新本脚本)`); fs.rmSync(d, { recursive: true, force: true }); return; }
  fs.writeFileSync(f, src.replace(from, to));
  const r = run(d);
  const killed = r.failed.length > 0;
  if (!killed) ok = false;
  console.log(`${killed ? "✓" : "✗"} ${name}:${r.passed.length} 绿 / ${r.failed.length} 红${killed ? `,被「${r.failed[0]}」发现` : ",存活"}`);
  fs.rmSync(d, { recursive: true, force: true });
});
fs.rmSync(tmp, { recursive: true, force: true });
console.log(ok ? "变异校准通过" : "变异校准失败");
process.exit(ok ? 0 : 1);
