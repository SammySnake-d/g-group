import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { all, one } from "./db.ts";
import { startServer } from "./start.ts";

const MODEL_A = "model-A";
const MODEL_B = "model-B";
const env = { ANTHROPIC_DEFAULT_SONNET_MODEL: MODEL_A, ANTHROPIC_API_KEY: "NEUTRAL_FIXTURE_B4_NOT_A_CREDENTIAL", ANTHROPIC_BASE_URL: "http://fixture.invalid" };
const evt = (type: string, props: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...props })}\n\n`;
const settled = (s: Awaited<ReturnType<typeof startServer>>) => !s.host.loop.busy();

function sse(model: string, text: string) {
  return new Response([
    evt("message_start", { message: { id: "fixture", type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } }),
    evt("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
    evt("content_block_delta", { index: 0, delta: { type: "text_delta", text } }),
    evt("content_block_stop", { index: 0 }),
    evt("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } }),
    evt("message_stop", {}),
  ].join(""), { headers: { "content-type": "text/event-stream" } });
}

async function until(cond: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!cond()) {
    if (Date.now() >= deadline) throw new Error("B4 gateway fixture did not settle within 5s");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function scene(start: typeof startServer, rejectB = false, explicit = true) {
  const dir = mkdtempSync(path.join(tmpdir(), "gg-b4-swap-"));
  const original = globalThis.fetch;
  const seen: { model: string; kind: string; body: string }[] = [];
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  globalThis.fetch = async (resource, init) => {
    const request = new Request(resource, init);
    const body = await request.text();
    const data = JSON.parse(body) as { model: string; tools?: unknown[] };
    const kind = data.tools?.length ? "round" : body.includes("只输出一个 JSON 对象") ? "reflect" : "shrink";
    seen.push({ model: data.model, kind, body });
    if (seen.length === 1) await blocked;
    if (rejectB && data.model === MODEL_B) return Response.json({ type: "error", error: { type: "authentication_error", message: "401 invalid x-api-key on model-B" } }, { status: 401 });
    if (kind === "reflect") {
      const first = seen.filter((r) => r.kind === "reflect").length === 1;
      return sse(data.model, JSON.stringify({ note: first ? `first-note ${"N".repeat(160)}` : "second-note", memories: first ? [{ title: "stable-fact", text: "remember-this", anchors: ["global"], relation: null, target: null }] : [], personaSuggestion: null }));
    }
    return sse(data.model, kind === "shrink" ? "first-note" : "done");
  };
  let s: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    const started = await start({ dataDir: dir, mind: "pi", env, stateNoteMaxBytes: 100 });
    s = started;
    const { host } = started;
    const c = host.createContact({ name: "B4", ...(explicit ? { speakingModel: MODEL_A } : {}) });
    const g = host.createGroup("B4 room", [{ kind: "contact", id: c.id }]);
    const task = host.createTask({ roomId: g.id, title: "Preserve task", clientActionId: "task" });
    const send = (key: string) => host.send({ roomId: g.id, text: `input-${key}`, clientActionId: key, mentions: [{ id: c.id, source: "manual" }] });
    const cursor = () => one<{ processed_seq: number }>(host.db, "SELECT processed_seq FROM gg_cursor WHERE contact_id = ? AND room_id = ?", c.id, g.id)?.processed_seq ?? 0;
    const first = send("first");
    await until(() => seen.length > 0);
    const close = async () => { release(); globalThis.fetch = original; await started.close(); rmSync(dir, { force: true, recursive: true }); };
    return { ...s, close, c, g, task, seen, release, cursor, send, first };
  } catch (error) {
    release(); globalThis.fetch = original; await s?.close(); rmSync(dir, { force: true, recursive: true }); throw error;
  }
}

test("B4 contacts.update holds the old model through round, reflection and shrink, then next round retains contact state", async () => {
  const s = await scene(startServer);
  try {
    const changed = await s.service.handle("contacts.update", { contactId: s.c.id, speakingModel: MODEL_B });
    assert.ok(changed.ok, JSON.stringify(changed));
    s.release();
    await until(() => s.cursor() >= s.first.seq && settled(s));
    assert.equal(s.host.stateNote(s.c.id), "first-note");
    const taskBefore = s.host.listTasks({ roomId: s.g.id });
    assert.equal(taskBefore[0]?.id, s.task.id);
    const second = s.send("second");
    await until(() => s.cursor() >= second.seq && settled(s));
    assert.deepEqual(s.seen.map(({ model, kind }) => [model, kind]), [[MODEL_A, "round"], [MODEL_A, "reflect"], [MODEL_A, "shrink"], [MODEL_B, "round"], [MODEL_B, "reflect"]]);
    assert.match(s.seen[3]?.body ?? "", /first-note/);
    assert.match(s.seen[3]?.body ?? "", /stable-fact/);
    assert.equal(s.host.stateNote(s.c.id), "second-note");
    assert.deepEqual(s.host.listTasks({ roomId: s.g.id }), taskBefore);
    assert.equal(s.cursor(), second.seq);
    assert.deepEqual(s.host.usage.rows().map((r) => [r.line.split("|").at(-1), r.kind]), [[MODEL_A, "round"], [MODEL_A, "reflect"], [MODEL_A, "compact"], [MODEL_B, "round"], [MODEL_B, "reflect"]]);
  } finally { await s.close(); }
});

test("B4 a rejected changed speaking model surfaces failure and never falls back to the prior model or advances the cursor", async () => {
  const s = await scene(startServer, true);
  try {
    s.release();
    await until(() => s.cursor() >= s.first.seq && settled(s));
    const changed = await s.service.handle("contacts.update", { contactId: s.c.id, speakingModel: MODEL_B });
    assert.ok(changed.ok);
    s.send("rejected");
    const failures = () => s.host.listMessages(s.g.id, {}).messages.filter((m) => m.card?.kind === "failure");
    await until(() => failures().length > 0 && settled(s));
    assert.equal(failures().length, 1);
    assert.deepEqual(s.seen.map((r) => r.model), [MODEL_A, MODEL_A, MODEL_A, MODEL_B]);
    assert.equal(s.host.listContacts()[0]?.speakingModel, MODEL_B);
    assert.equal(s.cursor(), s.first.seq);
    assert.equal(s.host.stateNote(s.c.id), "first-note");
    assert.deepEqual(all<{ kind: string }>(s.host.db, "SELECT kind FROM gg_usage ORDER BY id").map((row) => row.kind), ["round", "reflect", "compact"]);
  } finally { await s.close(); }
});

test("B4 settings.update and models.batchReplace reach inheriting contacts on their respective next turns", async () => {
  const s = await scene(startServer, false, false);
  try {
    const changed = await s.service.handle("settings.update", { defaultSpeakingModel: MODEL_B });
    assert.ok(changed.ok, JSON.stringify(changed));
    s.release();
    await until(() => s.cursor() >= s.first.seq && settled(s));
    const second = s.send("settings");
    await until(() => s.cursor() >= second.seq && settled(s));
    const batch = await s.service.handle("models.batchReplace", { from: MODEL_B, to: "model-C", apply: true, clientActionId: "batch" });
    assert.ok(batch.ok, JSON.stringify(batch));
    const third = s.send("batch");
    await until(() => s.cursor() >= third.seq && settled(s));
    assert.deepEqual(s.seen.map((r) => [r.model, r.kind]), [[MODEL_A, "round"], [MODEL_A, "reflect"], [MODEL_A, "shrink"], [MODEL_B, "round"], [MODEL_B, "reflect"], ["model-C", "round"], ["model-C", "reflect"]]);
    assert.deepEqual(s.host.usage.rows().filter((r) => r.kind === "round").map((r) => r.line.split("|").at(-1)), [MODEL_A, MODEL_B, "model-C"]);
  } finally { await s.close(); }
});
