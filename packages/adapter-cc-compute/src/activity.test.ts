// AC-43 ⑦/⑩/⑪ 的 harness 侧(需求文档 D26 第 8.3 节):从 Claude Code stream-json 的一行里认出「活动」——
// 模型调用已发出(首字节窗口起点)、真实进展、工具开始 / 结束、重试公告(不算进展)。宿主据此给运行台账计时。
// system/status 与 system/api_retry 两种帧的形状取自本机真实 Claude Code 2.1.319(抓取方式与原始行见 packages/server/proof/run-ledger-real-frames.txt)。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { activityOf } from "./events.ts";
import { cliArgs, createComputeAdapter, REPORT_TOOL } from "./index.ts";
import type { ComputeActivity } from "./types.ts";

const FAKE = fileURLToPath(new URL("../test-support/fake-claude.mjs", import.meta.url));
const dirs: string[] = [];
after(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true, maxRetries: 3 });
});

const brief = { task: "写一个文件", rules: [], tools: ["Read", "Write", "Bash"], credentialRefs: [], placement: "local" as const };

test("真实 CLI 发请求前的 system/status requesting 认成 model_call;api_retry 认成重试公告,带 HTTP 状态与原文", () => {
  assert.deepEqual(activityOf('{"type":"system","subtype":"status","status":"requesting","session_id":"7617b383","uuid":"4dd2780a"}'), [{ kind: "model_call" }]);
  assert.deepEqual(
    activityOf('{"type":"system","subtype":"api_retry","attempt":1,"max_retries":10,"retry_delay_ms":573,"error_status":null,"error":"unknown","session_id":"7617b383","uuid":"49e265a6"}'),
    [{ kind: "retry", error: "API 重试 第 1/10 次:unknown", httpStatus: null }],
  );
  assert.deepEqual(activityOf('{"type":"system","subtype":"api_retry","attempt":2,"max_retries":10,"error_status":503,"error":"server_error"}'), [
    { kind: "retry", error: "API 重试 第 2/10 次:API Error: 503 server_error", httpStatus: 503 },
  ]);
  // 别的 status 不是发请求
  assert.deepEqual(activityOf('{"type":"system","subtype":"status","status":"compacting"}'), []);
});

test("流式增量、文本块、思考块是真实进展;tool_use 是工具开始(Bash 后台命令、Task/Agent 子代理分别标出),tool_result 是工具结束", () => {
  assert.deepEqual(activityOf('{"type":"stream_event","event":{"type":"message_start"}}'), [{ kind: "progress", what: "output" }]);
  const assistant = JSON.stringify({
    type: "assistant",
    parent_tool_use_id: null,
    message: {
      content: [
        { type: "thinking", thinking: "想一想" },
        { type: "text", text: "我先跑测试" },
        { type: "tool_use", id: "tu-1", name: "Bash", input: { command: "npm test", run_in_background: true } },
        { type: "tool_use", id: "tu-2", name: "Task", input: { description: "查资料" } },
        { type: "tool_use", id: "tu-3", name: "Read", input: { file_path: "a.txt" } },
      ],
    },
  });
  assert.deepEqual(activityOf(assistant), [
    { kind: "progress", what: "thinking" },
    { kind: "progress", what: "text" },
    { kind: "tool_start", toolId: "tu-1", name: "Bash", background: true, subagent: false },
    { kind: "tool_start", toolId: "tu-2", name: "Task", background: false, subagent: true },
    { kind: "tool_start", toolId: "tu-3", name: "Read", background: false, subagent: false },
  ]);
  const user = JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu-3", content: "hello" }, { type: "tool_result", tool_use_id: "tu-2", is_error: true, content: "失败" }] } });
  assert.deepEqual(activityOf(user), [
    { kind: "tool_end", toolId: "tu-3", isError: false },
    { kind: "tool_end", toolId: "tu-2", isError: true },
  ]);
});

test("子代理里的消息(带 parent_tool_use_id)只算子代理的进展,不当成这一轮自己的工具开始和结束", () => {
  const inner = JSON.stringify({ type: "assistant", parent_tool_use_id: "tu-2", message: { content: [{ type: "tool_use", id: "inner-1", name: "Grep", input: {} }] } });
  assert.deepEqual(activityOf(inner), [{ kind: "progress", what: "subagent" }]);
  const innerResult = JSON.stringify({ type: "user", parent_tool_use_id: "tu-2", message: { content: [{ type: "tool_result", tool_use_id: "inner-1", content: "x" }] } });
  assert.deepEqual(activityOf(innerResult), [{ kind: "progress", what: "subagent" }]);
});

test("认不出的行、非 JSON、init 与 result 不产生活动;字段类型不对的块跳过;非字符串输入抛受控 TypeError", () => {
  assert.deepEqual(activityOf("不是 JSON"), []);
  assert.deepEqual(activityOf("[1,2]"), []);
  assert.deepEqual(activityOf('{"type":"system","subtype":"init","session_id":"s","tools":[],"mcp_servers":[]}'), []);
  assert.deepEqual(activityOf('{"type":"result","subtype":"success","result":"ok"}'), []);
  assert.deepEqual(activityOf(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: 7, name: "Bash" }, { type: "tool_use", id: "x", name: { n: 1 } }, "字符串块"] } })), []);
  assert.deepEqual(activityOf(JSON.stringify({ type: "system", subtype: "api_retry", error_status: "503", error: { message: "x" } })), [{ kind: "retry", error: "API 重试:", httpStatus: null }]);
  assert.throws(() => activityOf(42 as never), TypeError);
});

test("CLI 参数打开流式增量(--include-partial-messages):首字节与长输出进行中才有行可看,宿主不会把长生成误判成没回应", () => {
  const args = cliArgs(brief, "提示", "/nonexistent/mcp.json");
  assert.ok(args.includes("--include-partial-messages"));
  assert.ok(args.indexOf("--include-partial-messages") > args.indexOf("stream-json"));
  // 其余参数不受影响:提示原文、MCP 配置路径照旧
  assert.equal(args[args.indexOf("-p") + 1], "提示");
  assert.equal(args[args.indexOf("--mcp-config") + 1], "/nonexistent/mcp.json");
});

test("真实适配器接上假 CLI:init 核验通过后,流里的工具开始 / 结束作为活动发出,带 computeId;语义事件照常", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-cc-activity-"));
  dirs.push(dir);
  const script = { reports: [{ kind: "started", summary: "开始" }, { kind: "completed", summary: "完成" }], result: "success", text: "好了" };
  const a = createComputeAdapter({ runner: { command: process.execPath, args: [FAKE, `--fake-dir=${dir}${path.sep}`] }, hostEnv: { FAKE_SCRIPT: JSON.stringify(script), FAKE_RECORD: path.join(dir, "record.jsonl") }, reapForceMs: 1500 });
  const seen: ComputeActivity[] = [];
  const it = a.activity!()[Symbol.asyncIterator]();
  const pump = (async () => {
    for (;;) {
      const r = await it.next();
      if (r.done) return;
      seen.push(r.value);
    }
  })();
  const r = await a.spawn({ task: "写一个文件", rules: [], tools: ["Read"], credentialRefs: [], placement: "local" });
  assert.ok(r.ok);
  const evs = await a.settled(r.computeId);
  assert.deepEqual(evs.map((e) => e.kind), ["started", "completed"]);
  await new Promise((ok) => setTimeout(ok, 50));
  const tools = seen.filter((x) => x.kind === "tool_start" || x.kind === "tool_end");
  assert.ok(tools.length >= 4, `两次汇报各一开一合,实际 ${tools.length}`);
  assert.ok(seen.every((x) => x.computeId === r.computeId));
  const starts = seen.filter((x): x is Extract<ComputeActivity, { kind: "tool_start" }> => x.kind === "tool_start");
  assert.ok(starts.every((x) => x.name === REPORT_TOOL && !x.background && !x.subagent));
  const ends = seen.filter((x): x is Extract<ComputeActivity, { kind: "tool_end" }> => x.kind === "tool_end");
  assert.deepEqual(ends.map((x) => x.toolId).sort(), starts.map((x) => x.toolId).sort(), "每个开始都有对应的结束");
  void it.return?.();
  void pump;
});
