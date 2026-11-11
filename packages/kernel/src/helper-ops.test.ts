// Helper 的软件操作能力清单(U04/U05,D07.0/D28.1/AC-52)、Helper 专属 MCP 服务的协议层与 CSV 解析(US1 tasks.importCsv)的内核层测试。
// 清单与服务方法表的一一对账在 packages/server/src/helper-agent.test.ts(内核不依赖接口合同包)。
import assert from "node:assert/strict";
import test from "node:test";
import { parseCsv } from "./csv.ts";
import { createHelperMcpServer, HELPER_MCP_PROTOCOL, McpError, memoryMcpClient } from "./helper-mcp.ts";
import { HELPER_EXCLUDED, HELPER_OPS, type HelperMindInput, helperExclusion, helperOp, renderHelperPrompt, toolDescription } from "./helper-ops.ts";

type Obj = { type: string; properties: Record<string, unknown>; required: string[]; additionalProperties: boolean };

test("清单:工具名合规且不重复,方法名形如「域.动作」且不重复,参数是 type:object 的 JSON Schema、required 都在 properties 里、不收 clientActionId", () => {
  assert.ok(HELPER_OPS.length >= 60, `清单只有 ${HELPER_OPS.length} 项`);
  const names = HELPER_OPS.map((o) => o.name);
  const methods = HELPER_OPS.map((o) => o.method);
  assert.equal(new Set(names).size, names.length, "工具名重复");
  assert.equal(new Set(methods).size, methods.length, "方法名重复");
  for (const o of HELPER_OPS) {
    assert.match(o.name, /^[a-zA-Z0-9_-]{1,64}$/, o.name);
    assert.match(o.method, /^[a-z]+\.[a-zA-Z]+$/, o.method);
    assert.ok(["read", "write", "irreversible"].includes(o.kind), `${o.name} 种类 ${o.kind}`);
    assert.ok(o.label.trim() && o.description.trim(), `${o.name} 缺中文标签或说明`);
    const p = o.params as unknown as Obj;
    assert.equal(p.type, "object", o.name);
    assert.equal(p.additionalProperties, false, o.name);
    for (const r of p.required) assert.ok(Object.hasOwn(p.properties, r), `${o.name} required ${r} 不在 properties 里`);
    assert.equal(Object.hasOwn(p.properties, "clientActionId"), false, `${o.name} 的 clientActionId 应由宿主生成`);
    if (o.name !== "read_room") assert.equal(o.name, o.method.replace(".", "_"), "工具名 = 方法名把「.」换成「_」");
  }
  assert.equal(helperOp("read_room")?.method, "messages.list", "read_room 对应 messages.list");
  assert.equal(helperOp("rooms_createGroup")?.kind, "write");
  assert.equal(helperOp("messages_send"), null, "排除清单里的方法没有工具");
  assert.equal(helperOp("nope"), null);
  assert.equal(helperOp(42 as unknown as string), null);
});

test("不可逆或授权类正好是删除、移出、回退、撤下、撤回、取消、合入、撤销与装 / 更 / 卸插件;工具说明给它们标【先问用户】(软提示,只写在说明里),其余说明原样", () => {
  const irr = HELPER_OPS.filter((o) => o.kind === "irreversible").map((o) => o.method).sort();
  assert.deepEqual(irr, [
    "announcements.remove",
    "commitments.revoke",
    "contacts.remove",
    "messages.retract",
    "plugins.install",
    "plugins.uninstall",
    "plugins.update",
    "rooms.removeMember",
    "rooms.rewind",
    "schedules.remove",
    "tasks.cancel",
    "tasks.integrate",
  ]);
  for (const o of HELPER_OPS) {
    const d = toolDescription(o);
    if (o.kind === "irreversible") assert.ok(d.startsWith("【先问用户】") && d.includes(o.description), o.name);
    else assert.equal(d, o.description, o.name);
  }
  assert.equal(toolDescription(helperOp("contacts_remove")!), "【先问用户】删除一位联系人(不可恢复)。 不可逆或授权类:调用前先跟用户说清要做什么,等用户本人明确同意再调。");
});

test("排除清单:以用户身份发言、验收与退回、回答与授权、卡片按钮、共享文档都不给 Helper,每条带理由,与清单不相交;按工具名或方法名都查得到", () => {
  const ex = new Map(HELPER_EXCLUDED.map((x) => [x.method, x.reason]));
  for (const m of ["messages.send", "messages.edit", "tasks.accept", "tasks.reject", "tasks.answer", "cards.act", "plugins.send", "docs.list", "docs.get", "docs.create", "docs.commit", "docs.history"]) assert.ok(ex.get(m)?.trim(), `${m} 应在排除清单里且带理由`);
  assert.match(ex.get("tasks.accept")!, /AC-28/);
  assert.match(ex.get("tasks.answer")!, /U99|AC-20/);
  assert.match(ex.get("docs.create")!, /PR #56/);
  assert.equal(ex.size, HELPER_EXCLUDED.length, "排除清单重复");
  const ops = new Set(HELPER_OPS.map((o) => o.method));
  for (const m of ex.keys()) assert.equal(ops.has(m), false, `${m} 同时在清单和排除清单里`);
  assert.equal(helperExclusion("messages_send")?.method, "messages.send");
  assert.equal(helperExclusion("tasks.accept")?.reason, "验收交付要用户本人回复(AC-28)");
  assert.equal(helperExclusion("rooms_createGroup"), null);
});

const input = (over: Partial<HelperMindInput> = {}): HelperMindInput => ({
  model: "m",
  route: { entry: "global", contextRoomId: null, replyToSeq: null },
  text: "帮我建个群",
  context: "",
  history: [],
  skill: "# Helper 操作软件\n不可逆操作先问用户。",
  ...over,
});
test("Helper 提示:系统提示 = 身份 + 入口说明 + skill 原文;全局入口 user 消息里只有这句话;侧栏 / @ 带当前聊天与此前对话", () => {
  const g = renderHelperPrompt(input());
  assert.equal(g.user, "[用户这句话]\n帮我建个群");
  assert.equal(
    g.system,
    "你是 g-group 的 Helper,只为用户本人服务,帮他操作这个软件。\n\n这次从全局入口叫你:你看不到任何聊天记录。需要时先用 rooms_list 找会话 id,再用 read_room 读用户在场的会话。你的回复只出现在全局面板。\n\n# Helper 操作软件\n不可逆操作先问用户。",
  );
  const s = renderHelperPrompt(input({ route: { entry: "sidebar", contextRoomId: "g1", replyToSeq: null }, context: "#3 小克:进度如何", history: [{ role: "user", text: "早" }, { role: "helper", text: "早上好" }] }));
  assert.equal(s.user, "[当前聊天]\n#3 小克:进度如何\n\n[此前在这个入口的对话]\n用户:早\nHelper:早上好\n\n[用户这句话]\n帮我建个群");
  assert.match(s.system, /会话 g1 的侧栏叫你/);
  assert.match(s.system, /不会发到聊天里/);
  const m = renderHelperPrompt(input({ route: { entry: "mention", contextRoomId: "g1", replyToSeq: 7 }, context: "#7 用户:@Helper 建群" }));
  assert.match(m.system, /会作为一条 Helper 消息出现在这个聊天里,回复用户那条 #7/);
  assert.ok(m.user.startsWith("[当前聊天]\n#7 用户:@Helper 建群"));
});

test("Helper MCP 协议层:initialize / tools/list(= HELPER_OPS,说明用 toolDescription、inputSchema 即参数 schema)/ tools/call 走同一个执行口;未知工具与排除清单方法 -32602 不执行;其余错误码照 JSON-RPC", async () => {
  const seen: { name: string; args: unknown }[] = [];
  const server = createHelperMcpServer({
    tools: HELPER_OPS,
    call: async (name, args) => {
      seen.push({ name, args });
      if (name === "contacts_remove") throw new Error("库里没有这个人");
      return name === "rooms_createGroup" ? { ok: true, text: '{"id":"g9"}' } : { ok: false, text: "不行" };
    },
  });
  assert.deepEqual(await server.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }), { jsonrpc: "2.0", id: 1, result: { protocolVersion: HELPER_MCP_PROTOCOL, capabilities: { tools: {} }, serverInfo: { name: "g-group-helper", version: "0.1.0" } } });
  const listed = (await server.handle({ jsonrpc: "2.0", id: 2, method: "tools/list" }))?.result as { tools: { name: string; description: string; inputSchema: unknown }[] };
  assert.deepEqual(listed.tools.map((t) => t.name), HELPER_OPS.map((o) => o.name));
  for (const [k, t] of listed.tools.entries()) {
    assert.equal(t.description, toolDescription(HELPER_OPS[k]!));
    assert.equal(t.inputSchema, HELPER_OPS[k]!.params);
  }
  assert.equal(listed.tools.find((t) => t.name === "plugins_uninstall")?.description, "【先问用户】卸载一个插件。 不可逆或授权类:调用前先跟用户说清要做什么,等用户本人明确同意再调。");
  assert.deepEqual(await server.handle({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "rooms_createGroup", arguments: { title: "发布群", members: [] } } }), { jsonrpc: "2.0", id: 3, result: { content: [{ type: "text", text: '{"id":"g9"}' }], isError: false } });
  assert.deepEqual(await server.handle({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "contacts_list" } }), { jsonrpc: "2.0", id: 4, result: { content: [{ type: "text", text: "不行" }], isError: true } });
  assert.deepEqual(await server.handle({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "contacts_remove", arguments: { contactId: "c1" } } }), { jsonrpc: "2.0", id: 5, result: { content: [{ type: "text", text: "宿主执行出错:库里没有这个人" }], isError: true } });
  assert.deepEqual(seen, [{ name: "rooms_createGroup", args: { title: "发布群", members: [] } }, { name: "contacts_list", args: {} }, { name: "contacts_remove", args: { contactId: "c1" } }]);
  assert.deepEqual(await server.handle({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "messages_send", arguments: { roomId: "g", text: "x" } } }), {
    jsonrpc: "2.0",
    id: 6,
    error: { code: -32602, message: "Unknown tool: messages_send(messages.send 按权限不给 Helper:Helper 不以用户身份在聊天里发言;@Helper 的回复以 helper 发言者出现)" },
  });
  assert.deepEqual(await server.handle({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "shell" } }), { jsonrpc: "2.0", id: 7, error: { code: -32602, message: "Unknown tool: shell" } });
  assert.deepEqual(await server.handle({ jsonrpc: "2.0", id: 8, method: "tools/call", params: {} }), { jsonrpc: "2.0", id: 8, error: { code: -32602, message: "Invalid params: tools/call 缺少字符串工具名 name" } });
  assert.equal(seen.length, 3, "未知工具与排除方法都没执行");
  assert.deepEqual(await server.handle({ jsonrpc: "2.0", id: 9, method: "resources/list" }), { jsonrpc: "2.0", id: 9, error: { code: -32601, message: "method not found: resources/list" } });
  assert.deepEqual(await server.handle([1]), { jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid request: 请求必须是 JSON 对象" } });
  assert.equal(await server.handle({ jsonrpc: "2.0", method: "notifications/initialized" }), null, "通知不回");
  assert.deepEqual(await server.handle({ jsonrpc: "2.0", id: 10, method: "ping" }), { jsonrpc: "2.0", id: 10, result: {} });
  // 进程内传输:result 原样返回,error 抛 McpError
  const client = memoryMcpClient(server);
  assert.deepEqual(await client.request("tools/call", { name: "rooms_createGroup", arguments: {} }), { content: [{ type: "text", text: '{"id":"g9"}' }], isError: false });
  await assert.rejects(client.request("tools/call", { name: "tasks_accept" }), (e: unknown) => e instanceof McpError && e.code === -32602 && e.message === "Unknown tool: tasks_accept(tasks.accept 按权限不给 Helper:验收交付要用户本人回复(AC-28))");
});

// ---------------------------------------------------------------- CSV(RFC 4180)
test("CSV:引号里的逗号、换行与转义的双引号原样保留,CRLF 与 LF 都认,BOM 去掉,行号按原文起始行", () => {
  const r = parseCsv('\uFEFFtitle,owner,note\r\n写文档,小克,"含,逗号"\r\n"修 bug ""紧急""",,"第一行\r\n第二行"\n"末行",小研,"甲\n乙"\n后一行,,');
  assert.ok(r.ok, JSON.stringify(r));
  assert.deepEqual(r.header, ["title", "owner", "note"]);
  assert.deepEqual(
    r.rows.map((x) => [x.line, x.cells]),
    [
      [2, { title: "写文档", owner: "小克", note: "含,逗号" }],
      [3, { title: '修 bug "紧急"', owner: "", note: "第一行\r\n第二行" }],
      [5, { title: "末行", owner: "小研", note: "甲\n乙" }],
      [7, { title: "后一行", owner: "", note: "" }],
    ],
  );
  assert.deepEqual(r.errors, []);
  const lf = parseCsv("a,b\n1,2\n");
  assert.ok(lf.ok);
  assert.deepEqual([lf.rows.length, lf.errors.length], [1, 0], "结尾换行不算空行");
});

test("CSV:空行、缺列、多列逐行报错且不影响其他行;引号没闭合从那行起报错;缺表头、表头重复或有空列名整份拒收", () => {
  const r = parseCsv("title,owner\n任务一,小克\n\n任务二\n任务三,小研,多的\n任务四,");
  assert.ok(r.ok, JSON.stringify(r));
  assert.deepEqual(r.rows.map((x) => [x.line, x.cells.title, x.cells.owner]), [[2, "任务一", "小克"], [6, "任务四", ""]]);
  assert.deepEqual(r.errors, [
    { line: 3, reason: "空行" },
    { line: 4, reason: "缺列:表头 2 列,这行只有 1 列" },
    { line: 5, reason: "多列:表头 2 列,这行有 3 列" },
  ]);
  const open = parseCsv('t\n好的\n"没闭合\n后面');
  assert.ok(open.ok);
  assert.deepEqual(open.rows.map((x) => x.cells.t), ["好的"]);
  assert.deepEqual(open.errors, [{ line: 3, reason: "引号没有闭合,从这行起到结尾都没有导入" }]);
  assert.deepEqual(parseCsv(""), { ok: false, reason: "缺表头:第一行必须是列名" });
  assert.deepEqual(parseCsv("\n1,2"), { ok: false, reason: "缺表头:第一行必须是列名" });
  assert.deepEqual(parseCsv("a,a\n1,2"), { ok: false, reason: "表头列名重复:a" });
  assert.deepEqual(parseCsv("a,,b\n1,2,3"), { ok: false, reason: "表头有空列名" });
  assert.deepEqual(parseCsv('"a\n'), { ok: false, reason: "第 1 行的引号没有闭合" });
  assert.deepEqual(parseCsv(3 as unknown as string), { ok: false, reason: "CSV 必须是字符串" });
  const q = parseCsv('a\n""');
  assert.ok(q.ok);
  assert.deepEqual([q.rows.map((x) => x.cells.a), q.errors], [[""], []], "加了引号的空字段不是空行");
});
