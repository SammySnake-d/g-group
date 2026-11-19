import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { appendEvent } from "@g-group/adapter-sqlite";
import type { Inbound, MemoryEntry } from "@g-group/kernel";
import { formatMemoryProvenance } from "./bg-compaction.ts";
import { all, getDoc } from "./db.ts";
import { Host, type HostOptions } from "./host.ts";

function setup(t: TestContext, opts: Omit<HostOptions, "file">) {
  const dir = mkdtempSync(path.join(tmpdir(), "gg-bg-compact-"));
  let host: Host | undefined;
  t.after(async () => {
    try { await host?.close(); } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  const h = new Host({ ...opts, file: path.join(dir, "test.db") });
  host = h;
  const contact = h.createContact({ name: "C0" });
  const room = h.openDm(contact.id);
  const say = (text: string) => appendEvent(h.db.store, `room:${room.id}`, { kind: "user", id: h.userId }, { kind: "message", text }, new Date().toISOString()).seq;
  return { host: h, contact, room, say, round: () => h.runRound(contact.id, new AbortController().signal) };
}

function deferred() {
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  return { wait, release };
}

test("foreground overlaps reflection and adoption only removes batches through its watermark", { timeout: 2000 }, async t => {
  const entered = [deferred(), deferred()], finish = [deferred(), deferred()];
  const blocks: string[] = [];
  let calls = 0;
  const x = setup(t, {
    mind: () => ({ async round(input) {
      blocks.push(input.request.blocks[2]!.text);
      return { actions: [], stateNote: null };
    } }),
    compactor: () => ({
      async compact() { throw new Error("unexpected fallback"); },
      async reflect(req) {
        const index = calls++;
        entered[index]!.release();
        await finish[index]!.wait;
        return { note: [req.previous, req.material].filter(Boolean).join("\n"), memories: [], personaSuggestion: null };
      },
    }),
  });
  const pending = () => getDoc<{ inputs: Inbound[]; batches: { id: string; inputs: Inbound[] }[] }>(x.host.db, `note-pending:${x.contact.id}`)!.value;
  const foreground = async (round: Promise<unknown>) => assert.equal(await Promise.race([round, new Promise(resolve => setTimeout(() => resolve("timeout"), 200))]), "done");
  const rounds: Promise<unknown>[] = [];
  try {
    x.say("round one original");
    rounds.push(x.round());
    await entered[0]!.wait;
    await foreground(rounds[0]!);
    assert.equal(x.host.loop.busy(), true);
    x.say("round two original");
    rounds.push(x.round());
    await foreground(rounds[1]!);
    assert.match(blocks[1]!, /round one original/);
    assert.equal(calls, 1, "reflect runs serially for one contact");
    const both = pending();
    assert.equal(both.batches.length, 2);
    assert.deepEqual(both.inputs, both.batches.flatMap(b => b.inputs));

    finish[0]!.release();
    await entered[1]!.wait;
    assert.match(x.host.stateNote(x.contact.id)!, /round one original/);
    assert.doesNotMatch(x.host.stateNote(x.contact.id)!, /round two original/);
    assert.deepEqual(pending(), { batches: both.batches.slice(1), inputs: both.batches[1]!.inputs });
    finish[1]!.release();
    await x.host.idle();
    assert.match(x.host.stateNote(x.contact.id)!, /round one original[\s\S]*round two original/);
    assert.deepEqual(pending(), { batches: [], inputs: [] });
  } finally {
    for (const gate of finish) gate.release();
    await Promise.allSettled(rounds);
  }
});

test("expanded and read memory include source, update time and relations after the body or in the metadata", async t => {
  const seen: (string | null)[] = [];
  const x = setup(t, { mind: () => ({ async round(input, _signal, ctx) {
    seen.push(input.request.blocks[4]!.text, await ctx!.readMemory("m-c0"));
    return { actions: [], stateNote: null };
  } }) });
  const seq = x.say("use the C0 provenance rule");
  const updatedAt = new Date().toISOString();
  const e: MemoryEntry = {
    id: "m-c0", title: "C0 provenance rule", body: "body of C0 provenance rule", anchors: [`room:${x.room.id}`],
    version: 1, status: "active", validFrom: null, validTo: null, source: { roomId: x.room.id, seq, userQuote: false },
    supersedes: ["m-old"], supersededBy: null, refines: ["m-related"], conflictsWith: [], derivedFrom: [],
    evidence: [], uses: [], createdAt: updatedAt, updatedAt,
  };
  x.host.memory.put(x.contact.id, e);
  await x.round();
  const provenance = `(溯源: 更新于 ${updatedAt} · 来源 ${x.room.id}#${seq} · 替代 m-old · 细化 m-related)`;
  assert.ok(seen[0]?.includes(`${e.body}\n${provenance}`));
  for (const metadata of [`更新于:${updatedAt}`, `来源:${x.room.id}#${seq}`, "替代了 m-old", "细化 m-related"]) assert.ok(seen[1]?.includes(metadata), metadata);
  assert.equal(formatMemoryProvenance(e), provenance);
});

test("foreground remember rejects a target without a relation and a relation without a target", async t => {
  const x = setup(t, {
    mind: () => ({ async round(input) {
      const source = input.fresh[0]!;
      const base = { kind: "remember" as const, roomId: source.roomId, title: "claim", anchors: [`room:${source.roomId}`], sourceSeq: null, quote: null };
      return { actions: [
        { ...base, text: "target only", relation: null, target: "m-other" },
        { ...base, text: "relation only", relation: "refine" as const, target: null },
        { ...base, text: "valid control", relation: null, target: null },
      ], stateNote: null };
    } }),
  });
  x.say("record a claim");
  await x.round();
  assert.deepEqual(x.host.listMemories(x.contact.id).map(e => e.body), ["valid control"]);
  assert.equal(all(x.host.db, "SELECT action_id FROM gg_effects WHERE kind = 'remember' AND status = 'rejected'").length, 2);
});
