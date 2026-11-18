import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import type { ParamsOf, PlaybookView, RoomView } from "@g-group/api-contract";
import type { RoundInput } from "@g-group/kernel";
import { Host } from "./host.ts";
import { PlaybookStore } from "./playbook.ts";
import { createService } from "./service.ts";
import { all, run } from "./db.ts";
function setup(t: TestContext, HostClass: typeof Host, BookClass: typeof PlaybookStore) {
  const dir = mkdtempSync(path.join(tmpdir(), "p1a-playbook-")); const rounds: RoundInput[] = [];
  const host = new HostClass({ file: path.join(dir, "db"), dataDir: dir, maxDeferMs: 1, mind: () => ({ async round(i) { rounds.push(i); return { actions: [], stateNote: null }; } }) });
  t.after(async () => { await host.close(); rmSync(dir, { recursive: true, force: true }); });
  const a = host.createContact({ name: "a" }), b = host.createContact({ name: "b" });
  const room = host.createGroup("project", [{ kind: "contact", id: a.id }, { kind: "contact", id: b.id }]);
  const source = host.send({ roomId: room.id, clientActionId: "source", text: "PAIR_OBSERVATION: review first" });
  const book = new BookClass(host);
  const input: ParamsOf<"playbook.record"> = { roomId: room.id, sourceSeq: source.seq, scope: "team", subjectIds: [a.id], title: "REUSABLE_TEAM_PRACTICE", observation: "PAIR_OBSERVATION: review first", clientActionId: "record" };
  return { host, book, room, a, b, source, input, rounds, svc: createService(host) };
}
async function settled(host: Host) { for (let n = 0; n < 100; n++) { await host.idle(); await new Promise(r => setTimeout(r, 5)); if (!host.loop.busy()) return; } throw new Error("playbook round did not settle"); }
test("P1A playbook is active immediately, durable WITHOUT ROWID and independent of announcements", (t) => {
  const s = setup(t, Host, PlaybookStore); const e = s.book.record(s.input);
  assert.equal(e.status, "active"); assert.equal(e.createdBy, s.host.userId);
  assert.deepEqual(s.book.list({ roomId: s.room.id }), [e]); assert.deepEqual(s.host.announcements.list(s.room.id), []);
  assert.match(all<{ sql: string }>(s.host.db, "SELECT sql FROM sqlite_master WHERE name='gg_playbook'")[0]!.sql, /WITHOUT ROWID/i);
  assert.equal(new PlaybookStore(s.host).list()[0]?.id, e.id);
});
test("P1A record idempotency conflicts on changed payload even after invalidation", (t) => {
  const s = setup(t, Host, PlaybookStore); const e = s.book.record(s.input); assert.equal(s.book.record(s.input).id, e.id);
  s.book.invalidate(e.id); assert.equal(s.book.record(s.input).id, e.id);
  assert.throws(() => s.book.record({ ...s.input, observation: "different" }), /conflict|幂等|不同/);
});
test("P1A record rejects missing retracted hidden and rewound source", (t) => {
  const s = setup(t, Host, PlaybookStore);
  assert.throws(() => s.book.record({ ...s.input, sourceSeq: 999 }), /来源|source/);
  s.host.retractMessage(s.room.id, s.source.seq);
  assert.throws(() => s.book.record(s.input), /来源|source/);
});
test("P1A room membership and pair/team subject cardinality enforced", (t) => {
  const s = setup(t, Host, PlaybookStore);
  assert.throws(() => s.book.record({ ...s.input, subjectIds: [] }), /成员|subject/);
  assert.throws(() => s.book.record({ ...s.input, scope: "pair", subjectIds: [s.a.id, s.a.id] }), /成员|subject/);
  assert.throws(() => s.book.record({ ...s.input, scope: "pair", subjectIds: [s.a.id, "stranger"] }), /成员|subject/);
  run(s.host.db, "DELETE FROM gg_members WHERE room_id=? AND kind='user'", s.room.id);
  assert.throws(() => s.book.list({ roomId: s.room.id }), /成员|会话/);
  assert.throws(() => s.book.record(s.input), /成员|会话/);
  assert.deepEqual(s.book.list(), []);
});
test("P1A source retraction invalidates and scrubs observation before next context", async (t) => {
  const s = setup(t, Host, PlaybookStore); const e = s.book.record(s.input); await settled(s.host);
  s.host.retractMessage(s.room.id, s.source.seq); await settled(s.host);
  const entry = s.book.list({ roomId: s.room.id })[0]!;
  assert.equal(entry.id, e.id); assert.equal(entry.status, "invalidated"); assert.doesNotMatch(entry.observation, /PAIR_OBSERVATION/);
  assert.deepEqual(s.book.list({ status: "active" }), []);
  s.host.send({ roomId: s.room.id, clientActionId: "later", text: "next", mentions: [{ id: s.a.id, source: "manual" }] }); await settled(s.host);
  assert.doesNotMatch(s.rounds.at(-1)!.request.blocks.map(b => b.text).join("\n"), /PAIR_OBSERVATION/);
});
test("P1A explicit invalidate remove and promotion keep formal announcements separate", (t) => {
  const s = setup(t, Host, PlaybookStore); const e = s.book.record(s.input);
  const p = { entryId: e.id, roomId: s.room.id, clientActionId: "promote" };
  const ann = s.book.promote(p); assert.equal(ann.text, `${e.title}\n${e.observation}`);
  assert.equal(s.book.promote(p).id, ann.id); assert.equal(s.host.announcements.list(s.room.id).length, 1);
  assert.equal(s.book.list()[0]?.promotedAnnouncementId, ann.id);
  s.book.invalidate(e.id); assert.throws(() => s.book.promote({ ...p, clientActionId: "new" }), /active|生效/);
  assert.deepEqual(s.book.remove(e.id), { removed: true }); assert.deepEqual(s.book.list(), []);
});
test("P1A selective team/pair injection only in Block 5 never Block 1", async (t) => {
  const s = setup(t, Host, PlaybookStore); s.book.record(s.input);
  s.book.record({ ...s.input, scope: "pair", subjectIds: [s.a.id, s.b.id], title: "PAIR_PRACTICE", clientActionId: "pair" });
  await settled(s.host); s.host.send({ roomId: s.room.id, clientActionId: "next", text: "review", mentions: [{ id: s.a.id, source: "manual" }] }); await settled(s.host);
  const blocks = s.rounds.filter(r => r.contact.id === s.a.id).at(-1)!.request.blocks;
  assert.match(blocks[4]!.text, /REUSABLE_TEAM_PRACTICE/); assert.match(blocks[4]!.text, /PAIR_PRACTICE/);
  assert.doesNotMatch(blocks[0]!.text, /REUSABLE_TEAM_PRACTICE|PAIR_PRACTICE|PAIR_OBSERVATION/);
});
test("P1A clone clean room retains selected rules announcements transferable playbook, no work content", (t) => {
  const s = setup(t, Host, PlaybookStore); s.host.updateRoom(s.room.id, { rules: "keep rules" }); s.host.announcements.add(s.room.id, "formal", "ann");
  s.book.record(s.input); s.book.record({ ...s.input, scope: "pair", subjectIds: [s.a.id, s.b.id], clientActionId: "pair", title: "pair" });
  const revoked = s.book.record({ ...s.input, clientActionId: "revoked", title: "revoked" }); s.book.invalidate(revoked.id);
  s.host.createTask({ roomId: s.room.id, ownerContactId: s.a.id, clientActionId: "private-task", title: "private task", description: "PRIVATE_WORK" });
  const clone = s.book.clone({ fromRoomId: s.room.id, contactIds: [s.a.id], clientActionId: "clone" });
  assert.notEqual(clone.id, s.room.id); assert.equal(clone.rules, "keep rules");
  assert.equal(s.host.announcements.list(clone.id)[0]?.text, "formal");
  assert.deepEqual(s.book.list({ roomId: clone.id }).map(e => e.title), ["REUSABLE_TEAM_PRACTICE"]);
  assert.equal(s.host.listMessages(clone.id, {}).messages.length, 0); assert.equal(s.host.listTasks({ roomId: clone.id }).length, 0);
  for (const table of ["gg_cursor", "gg_compute", "gg_links", "gg_commitments", "gg_shared_docs"]) {
    const schema = all<{ name: string }>(s.host.db, `PRAGMA table_info(${table})`);
    if (schema.some(c => c.name === "room_id")) assert.equal(all(s.host.db, `SELECT * FROM ${table} WHERE room_id=?`, clone.id).length, 0);
  }
  assert.equal(s.book.clone({ fromRoomId: s.room.id, contactIds: [s.a.id], clientActionId: "clone" }).id, clone.id);
  assert.throws(() => s.book.clone({ fromRoomId: s.room.id, contactIds: [s.b.id], clientActionId: "clone" }), /conflict|幂等|不同/);
});
test("P1A clone defaults copy both contacts and pair entries but flags omit all template data", (t) => {
  const s = setup(t, Host, PlaybookStore); s.book.record({ ...s.input, scope: "pair", subjectIds: [s.a.id, s.b.id] });
  const copy = s.book.clone({ fromRoomId: s.room.id, clientActionId: "all" });
  assert.equal(copy.members.filter(m => m.kind === "contact").length, 2); assert.equal(s.book.list({ roomId: copy.id }).length, 1);
  const bare = s.book.clone({ fromRoomId: s.room.id, contactIds: [], copyRules: false, copyAnnouncements: false, copyPlaybook: false, clientActionId: "bare" });
  assert.equal(bare.rules, ""); assert.deepEqual(s.book.list({ roomId: bare.id }), []); assert.deepEqual(s.host.announcements.list(bare.id), []);
});
test("P1A additive playbook and clone RPCs validate and return wire results", async (t) => {
  const s = setup(t, Host, PlaybookStore); const result = await s.svc.handle("playbook.record", s.input); assert.equal(result.ok, true);
  const entry = result.ok ? result.value as PlaybookView : null; assert.ok(entry);
  const list = await s.svc.handle("playbook.list", { roomId: s.room.id }); assert.equal(list.ok, true);
  assert.deepEqual(list.ok && list.value, { entries: [entry] });
  const clone = await s.svc.handle("rooms.clone", { fromRoomId: s.room.id, clientActionId: "rpc" }); assert.equal(clone.ok, true);
  assert.notEqual(clone.ok && (clone.value as RoomView).id, s.room.id);
});

test("P1A hidden source rejects record and removes already recorded text from listing", (t) => {
  const s = setup(t, Host, PlaybookStore); s.book.record(s.input); s.host.hideMessages(s.room.id, [s.source.seq]);
  assert.throws(() => s.book.record({ ...s.input, clientActionId: "hidden" }), /来源|source/);
  assert.equal(s.book.list({ roomId: s.room.id })[0]?.status, "invalidated");
  assert.doesNotMatch(JSON.stringify(s.book.list()), /PAIR_OBSERVATION/);
});
test("P1A rewind invalidates source anchored playbook without leaking into clone", async (t) => {
  const s = setup(t, Host, PlaybookStore); const dm = s.host.openDm(s.a.id);
  const first = s.host.send({ roomId: dm.id, clientActionId: "base", text: "base" }); await settled(s.host);
  const source = s.host.send({ roomId: dm.id, clientActionId: "rewound", text: "rewound observation" }); await settled(s.host);
  s.book.record({ ...s.input, roomId: dm.id, sourceSeq: source.seq, observation: "rewound observation", clientActionId: "dm" });
  s.host.rewind({ roomId: dm.id, toSeq: first.seq, clientActionId: "rewind" });
  assert.deepEqual(s.book.list({ roomId: dm.id, status: "active" }), []);
  assert.throws(() => s.book.record({ ...s.input, roomId: dm.id, sourceSeq: source.seq, clientActionId: "bad" }), /来源|source/);
});
