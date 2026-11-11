// tasks.importCsv(US1 后端,AC-52「CSV 转本群任务」):CSV 每个数据行建成请求的那个群里的一个任务,不指定负责人就停在 T1 待认领;
// 逐行报错不影响其他行;整份不合格才拒收。前端入口是 Helper 侧栏上传 CSV,Helper 的 tasks_importCsv 工具也走这里。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import type { TaskView } from "@g-group/api-contract";
import type { ContactMind } from "@g-group/kernel";
import { run } from "./db.ts";
import { scriptedHelperMind } from "./fakes.ts";
import { whenHelperIdle } from "./helper-agent.ts";
import { Host } from "./host.ts";
import { createService } from "./service.ts";

const dir = mkdtempSync(path.join(tmpdir(), "gg-import-"));
after(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
const quiet: ContactMind = { round: async () => ({ actions: [], stateNote: null }) };
function mk() {
  const helper = scriptedHelperMind();
  const host = new Host({ file: path.join(dir, `i${++n}.db`), mind: () => quiet, helperMind: () => helper, maxDeferMs: 5 });
  const ke = host.createContact({ name: "小克" });
  const yan = host.createContact({ name: "小研" });
  const g = host.createGroup("项目群", [{ kind: "contact", id: ke.id }, { kind: "contact", id: yan.id }]);
  const other = host.createGroup("别的群", [{ kind: "contact", id: ke.id }]);
  return { host, ke, yan, g, other };
}
async function settle(host: Host) {
  for (let i = 0; i < 100; i++) {
    await host.idle();
    await whenHelperIdle(host);
    await new Promise((r) => setTimeout(r, 5));
    if (!host.loop.busy()) return;
  }
}
type Out = { tasks: TaskView[]; errors: { line: number; reason: string }[] };

test("CSV 转本群任务:带引号逗号换行的 CSV 正确拆行,每行一个 T1 待认领任务落在请求的群(不是别的群),其余列写进描述", async () => {
  const { host, g, other } = mk();
  const svc = createService(host);
  const csv = 'id,标题,说明\r\n1,"写发布说明,中英两版","先写中文\r\n再翻译"\r\n2,"修 ""登录"" 按钮",\r\n';
  const r = await svc.handle("tasks.importCsv", { clientActionId: "c1", roomId: g.id, csv });
  assert.ok(r.ok, JSON.stringify(r));
  const out = r.value as Out;
  assert.deepEqual(out.errors, []);
  assert.deepEqual(out.tasks.map((t) => [t.title, t.roomId, t.state, t.ownerContactId]), [
    ["写发布说明,中英两版", g.id, "T1_Open", null],
    ['修 "登录" 按钮', g.id, "T1_Open", null],
  ]);
  assert.deepEqual(host.listTasks({ roomId: other.id }), [], "别的群里没有任务");
  const cards = host.listMessages(g.id, {}).messages.map((m) => [m.sender.kind, m.text, m.card?.kind ?? null]);
  assert.deepEqual(cards, [
    ["user", "新建任务:写发布说明,中英两版\nid:1\n说明:先写中文\r\n再翻译", "task-status"],
    ["user", '新建任务:修 "登录" 按钮\nid:2', "task-status"],
  ]);
  await settle(host);
  await host.close();
});

test("空行、缺列、标题为空、负责人不对逐行报错不影响其他行;assigneeColumn 那格有值时交给这位联系人;同一 clientActionId 重发不重复建", async () => {
  const { host, g, ke } = mk();
  const svc = createService(host);
  const csv = ["任务,负责人", "任务一,", "", "任务二", " ,小克", "任务三,小李", "任务四,小克"].join("\n");
  const p = { clientActionId: "c2", roomId: g.id, csv, assigneeColumn: "负责人" };
  const r = await svc.handle("tasks.importCsv", p);
  assert.ok(r.ok, JSON.stringify(r));
  const out = r.value as Out;
  assert.deepEqual(out.errors, [
    { line: 3, reason: "空行" },
    { line: 4, reason: "缺列:表头 2 列,这行只有 1 列" },
    { line: 5, reason: "标题列「任务」为空" },
    { line: 6, reason: "负责人「小李」不是这个会话里的联系人" },
  ]);
  assert.deepEqual(out.tasks.map((t) => [t.title, t.ownerContactId]), [["任务一", null], ["任务四", ke.id]]);
  assert.equal(out.tasks[0]!.state, "T1_Open");
  const again = await svc.handle("tasks.importCsv", p);
  assert.ok(again.ok);
  assert.deepEqual((again.value as Out).tasks.map((t) => t.id), out.tasks.map((t) => t.id), "重发返回同一批任务");
  assert.equal(host.listTasks({ roomId: g.id }).length, 2, "没有重复建");
  await settle(host);
  await host.close();
});

test("整份拒收:缺表头、指定的标题列或负责人列不存在 → invalid_params;用户不在的会话 forbidden;都不建任务", async () => {
  const { host, g } = mk();
  const svc = createService(host);
  let k = 0;
  const bad = async (p: Record<string, unknown>) => {
    const r = await svc.handle("tasks.importCsv", { clientActionId: `x${++k}`, roomId: g.id, ...p });
    return !r.ok && [r.error.code, r.error.message];
  };
  assert.deepEqual(await bad({ csv: "\n任务一" }), ["invalid_params", "CSV 不能导入:缺表头:第一行必须是列名"]);
  assert.deepEqual(await bad({ csv: "a,b\n1,2", titleColumn: "标题" }), ["invalid_params", "表头里没有标题列「标题」(表头:a、b)"]);
  assert.deepEqual(await bad({ csv: "a,b\n1,2", assigneeColumn: "谁" }), ["invalid_params", "表头里没有负责人列「谁」(表头:a、b)"]);
  run(host.db, "DELETE FROM gg_members WHERE room_id = ? AND kind = 'user'", g.id);
  assert.deepEqual(await bad({ csv: "a\n1" }), ["forbidden", "你不在这个会话里"]);
  assert.deepEqual(host.listTasks({ roomId: g.id }), []);
  await host.close();
});

test("侧栏 Helper 把 CSV 变成任务:工具经 MCP 真执行,任务落在当前群、待认领;侧栏回复不上公屏,群里只多出任务卡消息", async () => {
  const { host, g } = mk();
  const svc = createService(host);
  const before = host.listMessages(g.id, {}).messages.length;
  const r = await svc.handle("helper.ask", { entry: { kind: "sidebar", roomId: g.id }, text: '把这个 CSV 变成任务:\ntitle,备注\n"整理, 发布清单",周五前\n回归测试,\n\n只有标题', clientActionId: "h1" });
  assert.ok(r.ok, JSON.stringify(r));
  const v = r.value as { reply: string; ops: { op: string; ok: boolean; summary: string }[] };
  assert.equal(v.reply, "导入了 2 个任务,2 行有问题:第 4 行 空行;第 5 行 缺列:表头 2 列,这行只有 1 列");
  assert.deepEqual(v.ops, [{ op: "tasks.importCsv", ok: true, summary: "CSV 转任务:tasks 2 条 errors 2 条" }]);
  const tasks = host.listTasks({ roomId: g.id });
  assert.deepEqual(tasks.map((t) => [t.title, t.roomId, t.state, t.ownerContactId]).sort(), [
    ["回归测试", g.id, "T1_Open", null],
    ["整理, 发布清单", g.id, "T1_Open", null],
  ]);
  const added = host.listMessages(g.id, {}).messages.slice(before);
  assert.deepEqual(added.map((m) => [m.sender.kind, m.card?.kind ?? null]), [["user", "task-status"], ["user", "task-status"]], "公屏上只有两张任务卡");
  assert.equal(added.some((m) => m.text.includes("导入了")), false, "侧栏回复不上公屏");
  await settle(host);
  await host.close();
});
