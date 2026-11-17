// 宿主接线的行为变异校准(R-05):对 host.ts 里授权与意图的接线逐个注入单一故障,在包内隔离副本里只跑 intent.test.ts,
// 每个变异都必须让至少一条具名测试失败;原样副本必须全绿(阴性对照)。副本放在 packages/server/.mut-*/ 下,
// 这样 @g-group/* 仍按仓库根 node_modules 解析;跑完删除。用法: MUT_JOBS=2 node packages/server/proof/auth-intent-host-mutations.mjs
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const PKG = path.resolve(import.meta.dirname, "..");
const M = [
  ["H01 派发不按群规收写工具", "const tools = [...this.computeToolsFor(e.taskId)];", "const tools = [...(this.opts.computeTools ?? DEFAULT_COMPUTE_TOOLS)];"],
  ["H02 续接不重新核工具", "(e.computeId, e.text, turn, { tools });", "(e.computeId, e.text, turn);"],
  ["H03 群规不进 brief", "const rules = this.roomRuleLines(e.roomId);", "const rules: string[] = [];"],
  ["H04 授权不分版本", "authz.hasGrant(this.authzOf(taskId).value.requests, taskId, doc.task.constraintVer)", "this.authzOf(taskId).value.requests.some((r) => r.state === \"granted\")"],
  ["H05 受阻不登记授权提问", "    if (ev.kind === \"blocked\") this.raiseAuthorizationTx(t, ev, out);\n", ""],
  ["H06 用户消息不对授权", "const consent = this.consentFromMessage(room.id, r.seq);", "const consent = { effects: [] as HostEffect[], appended: [] as { roomId: string; seq: number; sender: Member }[], tasks: [] as string[] };"],
  ["H07 授权后不续接 Compute", "      out.effects.push({ kind: \"resume\", taskId: t.id, computeId: t.computeId, text: `用户本人已同意", "      void ({ kind: \"resume\", taskId: t.id, computeId: t.computeId, text: `用户本人已同意"],
  ["H08 forward 带来源也不升版", "            if (a.sourceSeq !== undefined) {", "            if (false) {"],
  ["H09 交付不查结果依据版本", "            if (resultVer !== t.task.constraintVer) {", "            if (false) {"],
  ["H10 运行中被拒的补充不排队", "else if (/还在运行/.test(r.reason))", "else if (false)"],
  ["H11 本轮结束不续上排队补充", "if (ev.kind === \"completed\" && next.queued.length && t.task.computeId === ev.computeId)", "if (false)"],
  ["H12 交付不标 Applied", "if (applied.ok) this.putFollowTx(a.taskId, follow, { ...follow.value, state: applied.value });", ""],
  ["H13 改挂已落实时不停旧执行器", "if (e.kind === \"stop-for-rollback\") effects.push({ kind: \"halt\", taskId: input.fromTaskId, computeId: e.computeId });", "if (e.kind === \"stop-for-rollback\") void 0;"],
  ["H14 停止确认后不回滚重做", "for (const e of r.effects) if (e.kind === \"restore-workspace\") out.effects.push({ kind: \"resume\", taskId, computeId: ev.computeId, text: restoreText(e) });", ""],
  ["H15 改条件不让待授权过期", "    this.putFollowTx(taskId, f, { ...f.value, state: r.followUps });\n    this.expireAuthzTx(taskId);\n", "    this.putFollowTx(taskId, f, { ...f.value, state: r.followUps });\n"],
  ["H16 了结后提问卡状态不变", "s.effective ? \"done\" : \"expired\"", "\"open\""],
  ["H17 改挂冲突不报 conflict", "/关联版本已变/.test(r.reason) ? \"conflict\" : \"invalid_params\"", "\"invalid_params\""],
  ["H18 改挂不要求目标在同一会话", "    if (b.value.roomId !== input.roomId) throw new HostError(\"invalid_params\", `任务 ${input.toTaskId} 不在这个会话里`);\n", ""],
  ["H20 授权提问时放任联系人转达当回答", "              if (this.isAuthzQuestion(a.taskId, q.qId)) { reject(", "              if (false) { reject("],
  ["H21 授权卡按一般提问卡处理", "        if (card.task_id && isAuthzCard(card)) effects.push", "        if (false) effects.push"],
  ["H22 tasks.answer 不按表态映射", "    if (isAuthzCard(card)) {\n      const intent", "    if (false) {\n      const intent"],
  ["H19 改挂不重放给源任务", "          effects.push(...this.taskEffectsToHost(input.fromTaskId, r.from.taskEffects, text));", "          void text;"],
];
const run = (dir) => new Promise((res) => {
  const p = spawn(process.execPath, ["--test", "--test-reporter=tap", path.join(dir, "intent.test.ts")], { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  p.stdout.on("data", (d) => { out += d; });
  p.stderr.on("data", (d) => { out += d; });
  p.on("close", () => res({ pass: Number(/^# pass (\d+)/m.exec(out)?.[1] ?? 0), failed: [...out.matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1]) }));
});
let n = 0;
const copySrc = () => {
  const dir = path.join(PKG, `.mut-${process.pid}-${n++}`);
  fs.cpSync(path.join(PKG, "src"), dir, { recursive: true });
  return dir;
};
const base = copySrc();
const control = await run(base);
fs.rmSync(base, { recursive: true, force: true });
const lines = [`阴性对照(原样副本):${control.pass} 绿 / ${control.failed.length} 红`];
let bad = control.failed.length > 0 || control.pass === 0;
const results = new Array(M.length);
let next = 0;
await Promise.all(Array.from({ length: Math.max(1, Number(process.env.MUT_JOBS ?? 2)) }, async () => {
  while (next < M.length) {
    const i = next++;
    const [name, from, to] = M[i];
    const dir = copySrc();
    const f = path.join(dir, "host.ts");
    const src = fs.readFileSync(f, "utf8");
    if (!src.includes(from)) { results[i] = `✗ ${name}:注入点不存在`; bad = true; fs.rmSync(dir, { recursive: true, force: true }); continue; }
    fs.writeFileSync(f, src.replace(from, to));
    const r = await run(dir);
    fs.rmSync(dir, { recursive: true, force: true });
    if (r.failed.length === 0) { results[i] = `✗ ${name}:存活(${r.pass} 绿)`; bad = true; }
    else results[i] = `✓ ${name}:${r.pass} 绿 / ${r.failed.length} 红,被「${r.failed[0]}」发现`;
  }
}));
lines.push(...results);
const killed = results.filter((x) => x.startsWith("✓")).length;
lines.push(`合计 ${M.length} 个变异:杀死 ${killed},存活/无效 ${M.length - killed}`, bad ? "变异校准未通过" : "变异校准通过");
console.log(lines.join("\n"));
process.exit(bad ? 1 : 0);
