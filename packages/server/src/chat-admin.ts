// 群管理与消息操作(U03/U23/U26/U100,D05):群主、解散、群内禁言、本端隐藏(删除、多选删除、清空)。
// - 群主:建群的用户,建群同一事务写进 gg_room_owner;更早建的群没有这一行时取最先写入的用户成员(建群时第一个写入的就是建群人)。
// - 解散:先进「解散中」——只读,不再发言、不再送达联系人——本群在途任务全部收到真实停止确认后才「已解散」(AC-23/U09);记录保留。
// - 禁言(U03,候选:语义待用户定,只做最小一项):这个联系人在这个群发的消息被拒收,它每一轮输入里写明自己在这个群被禁言;
//   别的都不变——在途任务照跑、交付不改投、私聊不受影响、不另发通知。
// - 本端隐藏(U23):只影响用户自己这一端的视图(消息列表、搜索、会话预览);联系人上下文与其他成员不受影响,这是和撤回(AC-08,对所有人)的区别。
//   只追加(AC-05):每次删除/清空都是 gg_view_hides 里的新行,库里的触发器拒绝改写和删除;会话事件与 gg_msg 一律不碰。
import type { MemberRef } from "@g-group/api-contract";
import { type Db, all, one, run } from "./db.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS gg_room_owner (room_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS gg_dissolve (room_id TEXT PRIMARY KEY, by_id TEXT NOT NULL, client_action_id TEXT NOT NULL, started_at TEXT NOT NULL, done_at TEXT);
CREATE TABLE IF NOT EXISTS gg_member_mutes (room_id TEXT NOT NULL, contact_id TEXT NOT NULL, by_id TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (room_id, contact_id));
CREATE TABLE IF NOT EXISTS gg_view_hides (
  id INTEGER PRIMARY KEY AUTOINCREMENT, room_id TEXT NOT NULL, viewer_id TEXT NOT NULL, kind TEXT NOT NULL, seq INTEGER NOT NULL,
  client_action_id TEXT NOT NULL, at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS gg_view_hides_room ON gg_view_hides (room_id, viewer_id);
CREATE TRIGGER IF NOT EXISTS gg_view_hides_no_update BEFORE UPDATE ON gg_view_hides BEGIN SELECT RAISE(ABORT, 'view hides are append-only'); END;
CREATE TRIGGER IF NOT EXISTS gg_view_hides_no_delete BEFORE DELETE ON gg_view_hides BEGIN SELECT RAISE(ABORT, 'view hides are append-only'); END;
`;

/** 宿主自己的通知以这个发言者写进会话(只作上下文,不给联系人留处置义务)。只给宿主通知用。 */
export const SYSTEM_SENDER: { readonly kind: "system"; readonly id: string } = Object.freeze({ kind: "system", id: "host" });
/** 解散中或已解散的群里,发言与接新活被拒的原因。 */
export const DISSOLVED_REASON = "这个群已解散(或正在解散),只读:不能在这里发言或接新活";
/** system 消息被当作接活或承诺的来源时的拒收原因。 */
export const CONTEXT_ONLY_REASON = "系统通知只作上下文,不能作为接活或承诺的来源";
export type Dissolution = "dissolving" | "dissolved";

/** 被禁言的联系人在这个群发的消息被拒收时记的原因;也是它每一轮输入里看到的那一句事实。 */
export function muteReason(title: string): string {
  return `你在「${title}」群被禁言,在那里发的消息会被拒收`;
}

/** 搜索用的 SQL 片段:alias 表(有 room_id、seq 列)里这一行对 viewer(占一个 ? 参数)隐藏时为假。 */
export function notHiddenSql(alias: string): string {
  return `NOT EXISTS (SELECT 1 FROM gg_view_hides h WHERE h.room_id = ${alias}.room_id AND h.viewer_id = ? AND ((h.kind = 'seq' AND h.seq = ${alias}.seq) OR (h.kind = 'clear' AND ${alias}.seq <= h.seq)))`;
}

export class ChatAdmin {
  private readonly db: Db;
  private readonly now: () => string;
  constructor(deps: { readonly db: Db; readonly now: () => string }) {
    this.db = deps.db;
    this.now = deps.now;
    this.db.store.db.exec(SCHEMA);
  }

  // ---------- 群主 ----------
  /** 建群时记下群主(在建群事务里调用)。 */
  recordOwner(roomId: string, userId: string): void {
    run(this.db, "INSERT OR IGNORE INTO gg_room_owner (room_id, owner_id, at) VALUES (?, ?, ?)", roomId, userId, this.now());
  }
  ownerOf(roomId: string): string | null {
    const r = one<{ owner_id: string }>(this.db, "SELECT owner_id FROM gg_room_owner WHERE room_id = ?", roomId);
    if (r) return r.owner_id;
    return one<{ member_id: string }>(this.db, "SELECT member_id FROM gg_members WHERE room_id = ? AND kind = 'user' ORDER BY rowid LIMIT 1", roomId)?.member_id ?? null;
  }
  isOwner(roomId: string, userId: string): boolean {
    return this.ownerOf(roomId) === userId;
  }

  // ---------- 解散 ----------
  dissolution(roomId: string): Dissolution | null {
    const r = one<{ done_at: string | null }>(this.db, "SELECT done_at FROM gg_dissolve WHERE room_id = ?", roomId);
    return r ? (r.done_at ? "dissolved" : "dissolving") : null;
  }
  /** 解散中或已解散:只读。 */
  isClosed(roomId: string): boolean {
    return !!one(this.db, "SELECT 1 FROM gg_dissolve WHERE room_id = ?", roomId);
  }
  /** 开始解散;已经开始过(不论哪个 clientActionId)返回 false,什么都不改。 */
  beginDissolve(roomId: string, by: string, clientActionId: string): boolean {
    return run(this.db, "INSERT OR IGNORE INTO gg_dissolve (room_id, by_id, client_action_id, started_at) VALUES (?, ?, ?, ?)", roomId, by, clientActionId, this.now()) === 1;
  }
  /** 解散中 → 已解散(在事务里调用);不在解散中返回 false。 */
  finishDissolve(roomId: string): boolean {
    return run(this.db, "UPDATE gg_dissolve SET done_at = ? WHERE room_id = ? AND done_at IS NULL", this.now(), roomId) === 1;
  }

  // ---------- 禁言 ----------
  isMuted(roomId: string, contactId: string): boolean {
    return !!one(this.db, "SELECT 1 FROM gg_member_mutes WHERE room_id = ? AND contact_id = ?", roomId, contactId);
  }
  mutedIn(roomId: string): MemberRef[] {
    return all<{ contact_id: string }>(this.db, "SELECT contact_id FROM gg_member_mutes WHERE room_id = ? ORDER BY at, contact_id", roomId).map((r) => ({ kind: "contact", id: r.contact_id }));
  }
  /** 改禁言状态;状态没变返回 false。 */
  setMuted(roomId: string, contactId: string, muted: boolean, by: string): boolean {
    if (muted) return run(this.db, "INSERT OR IGNORE INTO gg_member_mutes (room_id, contact_id, by_id, at) VALUES (?, ?, ?, ?)", roomId, contactId, by, this.now()) === 1;
    return run(this.db, "DELETE FROM gg_member_mutes WHERE room_id = ? AND contact_id = ?", roomId, contactId) === 1;
  }
  /** 这位联系人现在不能往这个群发消息的原因(群已解散/解散中,或被禁言);能发返回 null。 */
  speakBlock(roomId: string, contactId: string): string | null {
    if (this.isClosed(roomId)) return DISSOLVED_REASON;
    if (this.isMuted(roomId, contactId)) return muteReason(this.titleOf(roomId));
    return null;
  }
  /** 联系人每一轮输入第 5 块里的那一句事实:它在哪些群被禁言;没被禁言返回空数组。 */
  muteNotes(contactId: string): { ref: string; text: string }[] {
    return all<{ room_id: string }>(this.db, "SELECT room_id FROM gg_member_mutes WHERE contact_id = ? ORDER BY room_id", contactId)
      .filter((r) => !this.isClosed(r.room_id))
      .map((r) => ({ ref: `禁言 ${r.room_id}`, text: muteReason(this.titleOf(r.room_id)) }));
  }
  private titleOf(roomId: string): string {
    return one<{ title: string }>(this.db, "SELECT title FROM gg_rooms WHERE id = ?", roomId)?.title ?? roomId;
  }

  // ---------- 本端隐藏 ----------
  /** viewer 在这个会话里隐藏了哪些 seq(删除的逐条 + 清空到的位置)。 */
  hidden(roomId: string, viewerId: string): (seq: number) => boolean {
    const rows = all<{ kind: string; seq: number }>(this.db, "SELECT kind, seq FROM gg_view_hides WHERE room_id = ? AND viewer_id = ?", roomId, viewerId);
    const seqs = new Set(rows.filter((r) => r.kind === "seq").map((r) => r.seq));
    const upto = Math.max(0, ...rows.filter((r) => r.kind === "clear").map((r) => r.seq));
    return (seq) => seq <= upto || seqs.has(seq);
  }
  /** 追加逐条隐藏(在事务里调用);已经隐藏的不再记。 */
  hide(roomId: string, viewerId: string, seqs: readonly number[], clientActionId: string): void {
    const already = this.hidden(roomId, viewerId);
    for (const seq of seqs) {
      if (already(seq)) continue;
      run(this.db, "INSERT INTO gg_view_hides (room_id, viewer_id, kind, seq, client_action_id, at) VALUES (?, ?, 'seq', ?, ?, ?)", roomId, viewerId, seq, clientActionId, this.now());
    }
  }
  /** 追加一条清空记录:upto(含)及之前全部隐藏(在事务里调用)。 */
  clear(roomId: string, viewerId: string, upto: number, clientActionId: string): void {
    run(this.db, "INSERT INTO gg_view_hides (room_id, viewer_id, kind, seq, client_action_id, at) VALUES (?, ?, 'clear', ?, ?, ?)", roomId, viewerId, upto, clientActionId, this.now());
  }

  /** RoomView 里群管理相关的字段(只给群)。 */
  groupFields(roomId: string): { ownerId?: string; dissolution?: Dissolution; mutedMembers?: MemberRef[] } {
    const owner = this.ownerOf(roomId);
    const d = this.dissolution(roomId);
    const muted = this.mutedIn(roomId);
    return { ...(owner ? { ownerId: owner } : {}), ...(d ? { dissolution: d } : {}), ...(muted.length ? { mutedMembers: muted } : {}) };
  }
}
