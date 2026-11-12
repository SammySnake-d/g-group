// AC-08 composition witness only. Production retraction via service; no Host fix here.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { RoundInput } from "@g-group/kernel";
import { scriptedCompute, scriptedMind } from "./fakes.ts";
import { Host } from "./host.ts";
import { createService } from "./service.ts";

async function waitUntil(ready: () => boolean): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (ready()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("fixture did not reach the explicitly held contact round");
}

async function quiet(host: Host, compute?: { drained(): boolean }): Promise<void> {
  for (let i = 0; i < 400; i++) {
    await host.idle();
    await new Promise((resolve) => setTimeout(resolve, 5));
    if (!host.loop.busy() && (!compute || compute.drained())) return;
  }
  assert.fail("fixture did not settle after releasing the contact round");
}

test("RC01 messages.retract: an in-flight draft derived from the retracted source must not reach chat", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "gg-retract-composition-"));
  let entered = false;
  let release = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  const host = new Host({
    file: path.join(dir, "host.db"), maxDeferMs: 5,
    mind: () => ({
      async round(input: RoundInput) {
        const source = input.fresh.find((f) => f.kind === "message" && f.text === "NEUTRAL_SOURCE_FOR_WITHDRAWAL");
        if (source?.kind !== "message") return { actions: [], stateNote: null };
        entered = true;
        await held;
        return { actions: [{ kind: "reply" as const, roomId: source.roomId, replyToSeq: source.seq, text: "OBSOLETE_DERIVED_DRAFT" }], stateNote: null };
      },
    }),
  });
  const service = createService(host);
  const contact = host.createContact({ name: "撤回组合夹具" });
  const dm = host.openDm(contact.id);
  try {
    const source = host.send({ roomId: dm.id, clientActionId: "rc-source", text: "NEUTRAL_SOURCE_FOR_WITHDRAWAL" });
    await waitUntil(() => entered);
    const result = await service.handle("messages.retract", { roomId: dm.id, seq: source.seq });
    assert.equal(result.ok, true, "real service retraction succeeds before allowing the held draft to return");
    const retracted = host.listMessages(dm.id, {}).messages.find((m) => m.seq === source.seq);
    assert.equal(retracted?.retracted, true, "source was actually retracted, not just hidden by the fixture");
    assert.equal(retracted?.text, "", "production projection no longer returns original source text");
    release();
    await quiet(host);
    const messages = host.listMessages(dm.id, {}).messages;
    const obsolete = messages.filter((m) => m.sender.kind === "contact" && m.text === "OBSOLETE_DERIVED_DRAFT");
    t.diagnostic(JSON.stringify({ sourceSeq: source.seq, retracted: retracted?.retracted, obsoleteReplySeqs: obsolete.map((m) => m.seq), messageCount: messages.length }));
    assert.deepEqual(obsolete, [], "AC-08: retracted-source draft must not publish after the retract receipt");
  } finally {
    release();
    await quiet(host);
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  }
});


test("RC02 positive control: the same live source really publishes its derived reply without a retract", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gg-retract-control-"));
  const host = new Host({ file: path.join(dir, "host.db"), maxDeferMs: 5, mind: () => ({
    async round(input: RoundInput) {
      const source = input.fresh.find((f) => f.kind === "message" && f.sender.kind === "user");
      return { actions: source?.kind === "message" ? [{ kind: "reply" as const, roomId: source.roomId, replyToSeq: source.seq, text: "OBSOLETE_DERIVED_DRAFT" }] : [], stateNote: null };
    },
  }) });
  const contact = host.createContact({ name: "未撤回对照" });
  const dm = host.openDm(contact.id);
  try {
    const source = host.send({ roomId: dm.id, clientActionId: "rc-positive", text: "NEUTRAL_SOURCE_FOR_WITHDRAWAL" });
    await quiet(host);
    const replies = host.listMessages(dm.id, {}).messages.filter((m) => m.sender.kind === "contact" && m.text === "OBSOLETE_DERIVED_DRAFT");
    assert.deepEqual(replies.map((m) => m.replyToSeq), [source.seq], "a working reply route is required for RC01 to be non-vacuous");
  } finally { await host.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("RC03 messages.retract: an already-written external artifact stays real and the user gets an explicit cannot-retract hint", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "gg-retract-effects-"));
  const artifact = path.join(dir, "already-written.txt");
  let writes = 0;
  // Deliberately a deterministic Compute fixture, not a real model/CLI proof.
  // Its side effect is a real durable file, observed independently of task state.
  const compute = scriptedCompute({ script() {
    writes++;
    writeFileSync(artifact, "NEUTRAL_ALREADY_COMMITTED_ARTIFACT");
    return [{ kind: "started", sessionId: "rc-effects", resumed: false }, { kind: "completed", result: "已写入工件" }];
  } });
  const host = new Host({ file: path.join(dir, "host.db"), maxDeferMs: 5, mind: () => scriptedMind(), compute: () => compute.adapter });
  const service = createService(host);
  const contact = host.createContact({ name: "已发生副作用夹具" });
  const dm = host.openDm(contact.id);
  try {
    const source = host.send({ roomId: dm.id, clientActionId: "rc-effects", text: "帮我写入一个工件" });
    await quiet(host, compute);
    assert.equal(writes, 1, "the side effect actually happened before withdrawal");
    assert.equal(readFileSync(artifact, "utf8"), "NEUTRAL_ALREADY_COMMITTED_ARTIFACT");
    assert.ok(host.listTasks({ roomId: dm.id }).some((task) => task.recentProgress.some((progress) => progress.kind === "completed")), "production Host persisted the completed Compute result");
    const result = await service.handle("messages.retract", { roomId: dm.id, seq: source.seq });
    assert.equal(result.ok, true);
    await quiet(host, compute);
    assert.equal(existsSync(artifact), true, "withdrawal must not pretend to undo an external write");
    assert.equal(readFileSync(artifact, "utf8"), "NEUTRAL_ALREADY_COMMITTED_ARTIFACT");
    assert.equal(writes, 1, "withdrawal does not repeat the already-committed effect");
    const messages = host.listMessages(dm.id, {}).messages;
    const visible = JSON.stringify({ result, messages });
    t.diagnostic(JSON.stringify({ sourceSeq: source.seq, artifactStillPresent: existsSync(artifact), writes, taskStates: host.listTasks({ roomId: dm.id }).map((task) => task.state), visibleText: messages.map((m) => m.text) }));
    assert.match(visible, /已发生[^。\n]{0,80}(无法撤回|不会被撤销|不能撤回|未撤销)/, "AC-08: the real retract response/chat must explicitly disclose already-happened, cannot-retract effects");
  } finally { compute.close(); await host.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("RC04 deleting K retains an independent later requirement N in state-note context across restart", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gg-retract-later-"));
  const file = path.join(dir, "host.db");
  const K = "NEUTRAL_RETRACTED_CONSTRAINT_K";
  const N = "NEUTRAL_LATER_CONSTRAINT_N";
  const requests: RoundInput["request"][] = [];
  const mind = () => ({ async round(input: RoundInput) {
    requests.push(input.request);
    const source = [...input.fresh].reverse().find((f) => f.kind === "message");
    const stateNote = source?.kind === "message" && source.text === K ? K : source?.kind === "message" && source.text === N ? `${K};${N}` : null;
    return { actions: [], stateNote };
  } });
  let host = new Host({ file, dataDir: dir, maxDeferMs: 5, mind });
  const contact = host.createContact({ name: "K后约束夹具" });
  const dm = host.openDm(contact.id);
  try {
    const k = host.send({ roomId: dm.id, clientActionId: "rc-k", text: K }); await quiet(host);
    const n = host.send({ roomId: dm.id, clientActionId: "rc-n", text: N }); await quiet(host);
    assert.ok(n.seq > k.seq);
    assert.equal(host.stateNote(contact.id), `${K};${N}`, "both requirement sources really entered durable working state");
    const result = await createService(host).handle("messages.retract", { roomId: dm.id, seq: k.seq });
    assert.equal(result.ok, true); await quiet(host);
    assert.ok(host.stateNote(contact.id)?.includes(N), "deleting K must not discard later independent N");
    assert.ok(!host.stateNote(contact.id)?.includes(K), "K is scrubbed, rather than keeping everything indiscriminately");
    assert.equal(host.listMessages(dm.id, {}).messages.find((m) => m.seq === n.seq)?.text, N);
    await host.close();
    host = new Host({ file, dataDir: dir, maxDeferMs: 5, mind });
    host.send({ roomId: dm.id, clientActionId: "rc-after-restart", text: "核验剩余条件" }); await quiet(host);
    const last = requests.at(-1);
    assert.ok(last, "a new real round was assembled after restart");
    const context = last.blocks.map((block) => block.text).join("\n");
    assert.ok(context.includes(N), "later requirement N survives restart and is delivered to the next round");
    assert.ok(!context.includes(K), "retracted K is absent from every assembled block after restart");
  } finally { await host.close(); rmSync(dir, { recursive: true, force: true }); }
});
