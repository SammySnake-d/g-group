// 手工变异:把召回规划与宿主超预算处理逐个改坏,跑具名测试,确认每个变异都被至少一条测试按名杀死。
// 用法(仓库根目录):node packages/server/proof/e-recall-mutations.mjs > packages/server/proof/e-recall-mutations.txt
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const KERNEL = "packages/kernel/src/recall.ts";
const HOST = "packages/server/src/host.ts";
const KT = "packages/kernel/src/recall.test.ts";
const HT = "packages/server/src/recall.test.ts";

const MUTANTS = [
  { id: "M1 去掉保底切片(先到先得,首条超长吞掉后续)", file: KERNEL, from: "c.alloc = Math.min(c.total, x.minSliceBytes);", to: "c.alloc = 0;", tests: [KT, HT] },
  { id: "M2 撤回不占位、按原文换入", file: KERNEL, from: 'else if (src.retracted) pushOwn(states, "DeletedOrWithdrawn");', to: 'else if (src.retracted && false) pushOwn(states, "DeletedOrWithdrawn");', tests: [KT, HT] },
  { id: "M3 跨会话引用不拒绝", file: KERNEL, from: "if (r.roomId !== r.fromRoomId || !readable.has(r.roomId) || !src)", to: "if (!src)", tests: [KT] },
  { id: "M4 主回复不优先补满", file: KERNEL, from: "if (!c.primary || left === 0) continue;", to: "continue;", tests: [KT, HT] },
  { id: "M5 保底装不下时不显式失败", file: KERNEL, from: "if (need > x.budgetBytes) {", to: "if (need > x.budgetBytes && false) {", tests: [KT] },
  { id: "M6 截断不带续读游标", file: KERNEL, from: "const nextCursor = Object.freeze({ offset: cut.text.length, remainingBytes: st.total - cut.bytes });", to: "const nextCursor = null;", tests: [KT, HT] },
  { id: "M7 宿主只换入前两条引用(取最近 N 条)", file: HOST, from: "for (const q of [...(raw.replyTo !== null ? [raw.replyTo] : []), ...raw.quoted]) {", to: "for (const q of [...(raw.replyTo !== null ? [raw.replyTo] : []), ...raw.quoted].slice(0, 2)) {", tests: [HT] },
  { id: "M8 窗口内消息也重复换入", file: HOST, from: "if (src && !src.retracted && fresh.some(", to: "if (false && fresh.some(", tests: [HT] },
  { id: "M9 整轮超预算照旧抛错(后台退避重跑、用户看不到)", file: HOST, from: 'return this.failRound(contactId, roundId, focusRoom ?? fresh[0]!.roomId, lastSeen, inbox, { reason: "over-budget"', to: 'throw e; return this.failRound(contactId, roundId, focusRoom ?? fresh[0]!.roomId, lastSeen, inbox, { reason: "over-budget"', tests: [HT] },
  { id: "M10 同一批反复出失败卡", file: HOST, from: "    if (open) {\n      run(this.db, \"UPDATE gg_cards SET body", to: "    if (open && false) {\n      run(this.db, \"UPDATE gg_cards SET body", tests: [HT] },
  { id: "M11 跳过本轮不推进游标", file: HOST, from: "    this.advanceCursorsTx(meta.contactId, meta.lastSeen ?? {});\n    for (const id of meta.inboxIds", to: "    for (const id of meta.inboxIds", tests: [HT] },
];

function runTests(file) {
  try {
    const out = execFileSync(process.execPath, ["--test", "--test-reporter=spec", file], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 300_000 });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}
const failedNames = (out) => [...new Set(out.split("\n").filter((l) => /^✖ /.test(l) && !/failing tests/.test(l)).map((l) => l.replace(/^✖ /, "").replace(/ \(\d+(\.\d+)?ms\)$/, "")))];

let killed = 0;
console.log(`# e-recall 手工变异 ${new Date().toISOString()} @ ${execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim()}`);
for (const t of [KT, HT]) {
  const base = runTests(t);
  console.log(`基线 ${t}: ${base.code === 0 ? "全绿" : `失败(${failedNames(base.out).join(" | ")})`}`);
  if (base.code !== 0) process.exit(2);
}
for (const m of MUTANTS) {
  const orig = readFileSync(m.file, "utf8");
  if (!orig.includes(m.from)) {
    console.log(`\n## ${m.id}\n  变异点没找到(源码已变),判为无效`);
    process.exit(3);
  }
  writeFileSync(m.file, orig.replace(m.from, m.to));
  try {
    const names = [];
    for (const t of m.tests) {
      const r = runTests(t);
      for (const n of failedNames(r.out)) names.push(`${t.split("/").pop()} › ${n}`);
    }
    const dead = names.length > 0;
    if (dead) killed++;
    console.log(`\n## ${m.id}\n  ${m.file}: ${JSON.stringify(m.from).slice(0, 120)} → ${JSON.stringify(m.to).slice(0, 120)}\n  结果: ${dead ? "杀死" : "存活"}`);
    for (const n of names) console.log(`  ✖ ${n}`);
  } finally {
    writeFileSync(m.file, orig);
  }
}
console.log(`\n# 合计 ${MUTANTS.length} 个变异,杀死 ${killed},存活 ${MUTANTS.length - killed}`);
process.exit(killed === MUTANTS.length ? 0 : 1);
