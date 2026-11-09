import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type AgentEvent,
  changedFiles,
  collectDeliverables,
  digest,
  formatDuration,
  groupTranscript,
  mergeEvents,
  sessionElapsedMs,
  summarizeWork,
  type ToolEvent,
  toolKind,
  type TranscriptEvent,
} from "./transcript.ts";

const at = "2026-11-09T02:12:00+08:00";
const tool = (seq: number, name: string, extra: Partial<ToolEvent> = {}): ToolEvent => ({ kind: "tool", id: `t${seq}`, seq, at, name, summary: name, status: "ok", ...extra });
const text = (seq: number, t: string): TranscriptEvent => ({ kind: "text", id: `x${seq}`, seq, at, text: t });
const agent = (seq: number, status: AgentEvent["status"], trail: ToolEvent[] = []): AgentEvent => ({ kind: "agent", id: `a${seq}`, seq, at, label: `子代理 ${seq}`, brief: "查", status, calls: trail.length, durationMs: 1000, trail });

test("toolKind:Claude Code 与 Codex 的工具名归到同一套类别,大小写不敏感,不认识的算 other", () => {
  assert.deepEqual(
    ["Edit", "Write", "apply_patch", "Bash", "shell", "Read", "Grep", "Glob", "WebFetch", "WebSearch", "TodoWrite"].map(toolKind),
    ["edit", "edit", "edit", "command", "command", "read", "search", "search", "web", "web", "other"],
  );
  assert.equal(toolKind("  BASH "), "command");
});

test("groupTranscript:连续的工具调用并成一组,被文字隔开就另起一组;交付不进对话流", () => {
  const events: TranscriptEvent[] = [
    { kind: "prompt", id: "p", seq: 0, at, from: "claude", text: "改登录页" },
    tool(1, "Read"),
    tool(2, "Grep"),
    text(3, "先换变量"),
    tool(4, "Edit", { changes: [{ path: "a.tsx", added: 3, removed: 2 }] }),
    tool(5, "Bash"),
    { kind: "deliverable", id: "d", seq: 6, at, name: "截图", type: "file", ref: "shot.png" },
    text(7, "好了"),
  ];
  const blocks = groupTranscript(events);
  assert.deepEqual(blocks.map((b) => b.type), ["prompt", "tools", "text", "tools", "text"]);
  const [, first, , second] = blocks;
  assert.ok(first?.type === "tools" && second?.type === "tools");
  assert.deepEqual(first.calls.map((c) => c.event.id), ["t1", "t2"]);
  assert.equal(first.key, "t1");
  assert.deepEqual({ edit: second.tally.edit, command: second.tally.command, added: second.tally.added, removed: second.tally.removed }, { edit: 1, command: 1, added: 3, removed: 2 });
});

test("groupTranscript:乱序到达的事件按 seq 排好再分组", () => {
  const blocks = groupTranscript([tool(3, "Bash"), text(2, "中间"), tool(1, "Read")]);
  assert.deepEqual(blocks.map((b) => b.key), ["t1", "x2", "t3"]);
});

test("groupTranscript:失败后重试——标出第几次尝试、失败是否已被后面的重试救回,组上计数", () => {
  const blocks = groupTranscript([
    tool(1, "WebFetch", { status: "failed" }),
    tool(2, "WebFetch", { status: "failed", retryOf: "t1" }),
    tool(3, "WebFetch", { status: "ok", retryOf: "t2" }),
    text(4, "拿到了"),
    tool(5, "Bash", { status: "failed" }),
    tool(6, "Bash", { status: "running", retryOf: "t5" }),
  ]);
  const [g1, , g2] = blocks;
  assert.ok(g1?.type === "tools" && g2?.type === "tools");
  assert.deepEqual(g1.calls.map((c) => [c.attempt, c.recovered]), [[1, true], [2, true], [3, false]]);
  assert.equal(g1.failed, 2);
  assert.equal(g1.recovered, 2);
  assert.equal(g1.running, false);
  /* 重试还在跑:失败还没被救回 */
  assert.deepEqual(g2.calls.map((c) => [c.attempt, c.recovered]), [[1, false], [2, false]]);
  assert.equal(g2.failed, 1);
  assert.equal(g2.recovered, 0);
  assert.equal(g2.running, true);
});

test("groupTranscript:retryOf 成环也不会死循环", () => {
  const blocks = groupTranscript([tool(1, "Bash", { status: "failed", retryOf: "t2" }), tool(2, "Bash", { status: "failed", retryOf: "t1" })]);
  const [g] = blocks;
  assert.ok(g?.type === "tools");
  assert.equal(g.recovered, 0);
  assert.ok(g.calls.every((c) => c.attempt >= 1 && c.attempt <= 3));
});

test("groupTranscript:连续子代理并成一组,数出进行中、已回来、失败", () => {
  const blocks = groupTranscript([agent(1, "running"), agent(2, "done"), agent(3, "failed"), agent(4, "running"), text(5, "等它们"), agent(6, "done")]);
  const [g, , g2] = blocks;
  assert.ok(g?.type === "agents" && g2?.type === "agents");
  assert.deepEqual([g.agents.length, g.running, g.done, g.failed], [4, 2, 1, 1]);
  assert.deepEqual([g2.agents.length, g2.running, g2.done], [1, 0, 1]);
});

test("changedFiles / summarizeWork:同一文件多次修改合并,失败的改动不算,子代理里的调用也算", () => {
  const events: TranscriptEvent[] = [
    tool(1, "Edit", { changes: [{ path: "a.tsx", added: 3, removed: 2 }] }),
    tool(2, "Edit", { status: "failed", changes: [{ path: "zzz.tsx", added: 9, removed: 9 }] }),
    tool(3, "Bash"),
    tool(4, "Bash", { status: "failed" }),
    tool(5, "Edit", { changes: [{ path: "a.tsx", added: 1, removed: 1 }, { path: "b.css", added: 5, removed: 0 }] }),
    agent(6, "done", [tool(7, "Write", { changes: [{ path: "c.spec.ts", added: 4, removed: 0 }] }), tool(8, "Bash")]),
  ];
  assert.deepEqual(changedFiles(events), [
    { path: "a.tsx", added: 4, removed: 3 },
    { path: "b.css", added: 5, removed: 0 },
    { path: "c.spec.ts", added: 4, removed: 0 },
  ]);
  assert.deepEqual(summarizeWork(events), {
    filesChanged: 3,
    commands: 3,
    calls: 7,
    failed: 2,
    agents: 1,
    byKind: { edit: 4, command: 3, read: 0, search: 0, web: 0, other: 0 },
  });
});

test("changedFiles 不改动传入的事件(合并用的是副本)", () => {
  const ev = tool(1, "Edit", { changes: [{ path: "a", added: 1, removed: 0 }] });
  changedFiles([ev, tool(2, "Edit", { changes: [{ path: "a", added: 5, removed: 5 }] })]);
  assert.deepEqual(ev.changes, [{ path: "a", added: 1, removed: 0 }]);
});

test("collectDeliverables:按出现顺序,同一个 ref 只留最后一版", () => {
  const d = (seq: number, ref: string, name: string): TranscriptEvent => ({ kind: "deliverable", id: `d${seq}`, seq, at, name, type: "file", ref });
  const out = collectDeliverables([d(1, "a.png", "v1"), text(2, "x"), d(3, "b.md", "文档"), d(4, "a.png", "v2")]);
  assert.deepEqual(out.map((x) => [x.ref, x.name]), [["b.md", "文档"], ["a.png", "v2"]]);
});

test("mergeEvents:新页里同 id 的事件覆盖旧的(在跑的调用变成功),整体按 seq 排", () => {
  const prev = [tool(1, "Read"), tool(2, "Bash", { status: "running" })];
  const merged = mergeEvents(prev, [tool(3, "Edit"), tool(2, "Bash", { status: "ok", output: "pass" })]);
  assert.deepEqual(merged.map((e) => e.id), ["t1", "t2", "t3"]);
  const t2 = merged[1];
  assert.ok(t2?.kind === "tool");
  assert.equal(t2.status, "ok");
  assert.equal(prev[1]?.status, "running");
});

test("formatDuration:秒、分秒(秒补两位)、时分(分补两位);非法与负数记 0s", () => {
  assert.equal(formatDuration(0), "0s");
  assert.equal(formatDuration(999), "0s");
  assert.equal(formatDuration(42_000), "42s");
  assert.equal(formatDuration(59_999), "59s");
  assert.equal(formatDuration(60_000), "1m00s");
  assert.equal(formatDuration(247_000), "4m07s");
  assert.equal(formatDuration(619_000), "10m19s");
  assert.equal(formatDuration(3_600_000), "1h00m");
  assert.equal(formatDuration(4_080_000), "1h08m");
  assert.equal(formatDuration(-5), "0s");
  assert.equal(formatDuration(Number.NaN), "0s");
});

test("sessionElapsedMs:结束了取起止差,在跑取到 now;时间坏了按 0", () => {
  const startedAt = "2026-11-09T02:12:00+08:00";
  assert.equal(sessionElapsedMs({ startedAt, endedAt: "2026-11-09T02:16:07+08:00" }, 0), 247_000);
  assert.equal(sessionElapsedMs({ startedAt, endedAt: null }, Date.parse("2026-11-09T02:13:00+08:00")), 60_000);
  assert.equal(sessionElapsedMs({ startedAt, endedAt: null }, Date.parse("2026-11-09T02:00:00+08:00")), 0);
  assert.equal(sessionElapsedMs({ startedAt: "坏", endedAt: null }, 1), 0);
});

test("digest:取输出第一行非空内容,超长截断加省略号,按字符不按字节", () => {
  assert.equal(digest("\n\n  3 passed, 1 failed  \nmore"), "3 passed, 1 failed");
  assert.equal(digest(undefined), "");
  assert.equal(digest("深色主题对比度不够", 5), "深色主题…");
  assert.equal(digest("abcde", 5), "abcde");
});
