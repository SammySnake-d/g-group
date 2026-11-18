// Observations are independent from formal announcements. Copies carry template provenance, never old room messages.
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { ParamsOf, PlaybookView, RoomView, AnnouncementView } from "@g-group/api-contract";
import { scrubRetracted } from "@g-group/kernel";
import { all, one, run, tx, HostError, getDoc, putDoc } from "./db.ts";
import { isRewound } from "./rewind.ts";
import type { Host } from "./host.ts";
interface Row { id: string; payload: string; action_id: string; input: string; template: number }
export class PlaybookStore {
  readonly host: Host;
  constructor(host: Host) {
    this.host = host;
    run(host.db, "CREATE TABLE IF NOT EXISTS gg_playbook (id TEXT PRIMARY KEY, room_id TEXT NOT NULL, source_seq INTEGER NOT NULL, payload TEXT NOT NULL, action_id TEXT NOT NULL UNIQUE, input TEXT NOT NULL, template INTEGER NOT NULL DEFAULT 0) WITHOUT ROWID");
  }
  private member(roomId: string) {
    const room = this.host.roomView(roomId);
    if (!room.members.some(m => m.kind === "user" && m.id === this.host.userId)) throw new HostError("forbidden", "你不是会话成员");
    return room;
  }
  private visible(roomId: string, seq: number) {
    if (isRewound(this.host.db, roomId, seq)) return false;
    return this.host.listMessages(roomId, { limit: 500, beforeSeq: seq + 1 }).messages.some(m => m.seq === seq && !m.retracted);
  }
  private rows() { return all<Row>(this.host.db, "SELECT * FROM gg_playbook ORDER BY id"); }
  private save(entry: PlaybookView) { run(this.host.db, "UPDATE gg_playbook SET payload=? WHERE id=?", JSON.stringify(entry), entry.id); return entry; }
  private entry(id: string): PlaybookView {
    const entry = this.list().find(e => e.id === id);
    if (!entry) throw new HostError("not_found", "没有协作观察"); return entry;
  }
  list(p: ParamsOf<"playbook.list"> = {}): PlaybookView[] {
    if (p.roomId) this.member(p.roomId);
    const entries: PlaybookView[] = [];
    for (const row of this.rows()) {
      let e = JSON.parse(row.payload) as PlaybookView;
      try { this.member(e.roomId); } catch { continue; }
      if (p.roomId && e.roomId !== p.roomId) continue;
      if (!row.template && !this.visible(e.roomId, e.sourceSeq)) {
        if (e.status === "invalidated" && e.title === "来源已撤下" && e.observation === "来源已撤下") {
          if ((!p.scope || e.scope === p.scope) && (!p.status || e.status === p.status)) entries.push(e);
          continue;
        }
        const old = this.host.listMessages(e.roomId, { limit: 500, beforeSeq: e.sourceSeq + 1 }).messages.find(m => m.seq === e.sourceSeq)?.text;
        const scrub = old ? scrubRetracted(e.observation, [old]) : null;
        e = this.save({ ...e, status: "invalidated", title: "来源已撤下", observation: scrub && !scrub.leaked && scrub.hits ? scrub.text : "来源已撤下", updatedAt: new Date().toISOString() });
      }
      if ((!p.scope || e.scope === p.scope) && (!p.status || e.status === p.status)) entries.push(e);
    }
    return entries;
  }
  record(p: ParamsOf<"playbook.record">): PlaybookView {
    const room = this.member(p.roomId);
    const prior = one<Row>(this.host.db, "SELECT * FROM gg_playbook WHERE action_id=?", `record:${p.clientActionId}`);
    if (prior) { if (!isDeepStrictEqual(JSON.parse(prior.input), p)) throw new HostError("conflict", "幂等请求内容不同"); return this.entry(prior.id); }
    if (!this.visible(p.roomId, p.sourceSeq)) throw new HostError("invalid_params", "来源 source 不存在、已撤回、隐藏或回退");
    const subjects = [...new Set(p.subjectIds)];
    if (subjects.length !== p.subjectIds.length || subjects.length < (p.scope === "pair" ? 2 : 1) || subjects.some(id => !room.members.some(m => m.id === id && (m.kind === "contact" || m.kind === "user")))) throw new HostError("invalid_params", "subject 成员不合法");
    const at = new Date().toISOString();
    const e: PlaybookView = { id: `pb-${randomUUID()}`, roomId: p.roomId, sourceSeq: p.sourceSeq, scope: p.scope, subjectIds: subjects, title: p.title, observation: p.observation, createdBy: this.host.userId, createdAt: at, updatedAt: at, status: "active", promotedAnnouncementId: null };
    run(this.host.db, "INSERT INTO gg_playbook (id,room_id,source_seq,payload,action_id,input) VALUES (?,?,?,?,?,?)", e.id, e.roomId, e.sourceSeq, JSON.stringify(e), `record:${p.clientActionId}`, JSON.stringify(p)); return e;
  }
  invalidate(id: string): PlaybookView { const e = this.entry(id); return this.save({ ...e, status: "invalidated", updatedAt: new Date().toISOString() }); }
  remove(id: string): { removed: boolean } { this.entry(id); run(this.host.db, "DELETE FROM gg_playbook WHERE id=?", id); return { removed: true }; }
  promote(p: ParamsOf<"playbook.promoteToAnnouncement">): AnnouncementView {
    const e = this.entry(p.entryId); this.member(p.roomId);
    const key = `playbook-promote:${p.clientActionId}`; const prior = getDoc<{ input: typeof p; value: AnnouncementView }>(this.host.db, key);
    if (prior) { if (!isDeepStrictEqual(prior.value.input, p)) throw new HostError("conflict", "幂等请求内容不同"); return prior.value.value; }
    if (e.status !== "active") throw new HostError("conflict", "只有生效 active 观察可以提升公告");
    if (e.roomId !== p.roomId) throw new HostError("forbidden", "只能提升到原会话");
    return tx(this.host.db, () => { const ann = this.host.announcements.add(p.roomId, `${e.title}\n${e.observation}`, `playbook:${p.clientActionId}`); this.save({ ...e, promotedAnnouncementId: ann.id }); putDoc(this.host.db, key, 0, { input: p, value: ann }); return ann; });
  }
  pointers(contactId: string, rooms: readonly string[]): { ref: string; text: string }[] {
    const entries = this.list({ status: "active" }).filter(e => rooms.includes(e.roomId) && (e.scope === "team" || e.subjectIds.includes(contactId)));
    const out: { ref: string; text: string }[] = []; let bytes = 0;
    for (const e of entries) { const pointer = { ref: `协作观察 ${e.id} · ${e.title}`, text: e.observation }; const n = Buffer.byteLength(JSON.stringify(pointer)); if (bytes + n > 8192) continue; out.push(pointer); bytes += n; }
    return out;
  }
  clone(p: ParamsOf<"rooms.clone">): RoomView {
    const source = this.member(p.fromRoomId); if (source.kind !== "group") throw new HostError("invalid_params", "只能克隆群");
    const key = `room-clone:${p.clientActionId}`; const prior = getDoc<{ input: typeof p; roomId: string }>(this.host.db, key);
    if (prior) { if (!isDeepStrictEqual(prior.value.input, p)) throw new HostError("conflict", "幂等请求内容不同"); return this.host.roomView(prior.value.roomId); }
    const active = source.members.filter(m => m.kind === "contact" && !this.host.exits.isLeaving(source.id, m.id)).map(m => m.id);
    const ids = [...new Set(p.contactIds ?? active)]; if (ids.some(id => !active.includes(id))) throw new HostError("invalid_params", "联系人不是活跃群成员");
    const cloned = tx(this.host.db, () => {
      const roomId = `g-${randomUUID()}`, at = new Date().toISOString();
      run(this.host.db, "INSERT INTO gg_rooms (id,kind,title,rules,rules_version,created_at,updated_at) VALUES (?, 'group', ?, ?, ?, ?, ?)", roomId, p.title ?? source.title, p.copyRules === false ? "" : source.rules, p.copyRules === false ? 0 : source.rulesVersion, at, at);
      run(this.host.db, "INSERT INTO gg_members (room_id,kind,member_id) VALUES (?, 'user', ?)", roomId, this.host.userId);
      for (const id of ids) run(this.host.db, "INSERT INTO gg_members (room_id,kind,member_id) VALUES (?, 'contact', ?)", roomId, id);
      const room = this.host.roomView(roomId);
      if (p.copyAnnouncements !== false) for (const a of this.host.announcements.list(source.id)) this.host.announcements.add(room.id, a.text, `clone:${a.id}`);
      if (p.copyPlaybook !== false) for (const e of this.list({ roomId: source.id, status: "active" })) {
        const retained = new Set([this.host.userId, ...ids]);
        if (!e.subjectIds.every(id => retained.has(id))) continue;
        const copy: PlaybookView = { ...e, id: `pb-${randomUUID()}`, roomId: room.id, sourceSeq: 0, createdBy: this.host.userId, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), promotedAnnouncementId: null };
        run(this.host.db, "INSERT INTO gg_playbook (id,room_id,source_seq,payload,action_id,input,template) VALUES (?,?,?,?,?,?,1)", copy.id, room.id, 0, JSON.stringify(copy), `clone:${p.clientActionId}:${e.id}`, JSON.stringify({ fromEntryId: e.id }));
      }
      putDoc(this.host.db, key, 0, { input: p, roomId: room.id }); return this.host.roomView(room.id);
    });
    this.host.bus.emit({ type: "room.updated", room: cloned });
    return cloned;
  }
}
