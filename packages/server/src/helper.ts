// Helper 三种意图(U94/D28 第 1 条)的后端接口:上下文读取范围、侧栏/全局问答记录、@Helper 时在聊天里公开回复。
// 权限按 domain/helper.ts 的 routeHelper:Helper 只为用户本人服务;回复出现在哪,跟着在哪叫它走。
import { randomUUID } from "node:crypto";
import type { MessageView } from "@g-group/api-contract";
import { type HelperEntry, routeHelper } from "@g-group/domain";
import { HostError, all, one, run } from "./db.ts";
import type { Host } from "./host.ts";

/** Helper 在会话里的发言者 id;用户 @Helper 时 mentions 里写它。 */
export const HELPER_ID = "helper";

export type HelperEntryInput = { kind: "global" } | { kind: "sidebar"; roomId: string } | { kind: "mention"; roomId: string; seq: number };
export interface HelperRouteView {
  replyIn: "global-panel" | "conversation" | "sidebar";
  becomesMessage: boolean;
  contextRoomId: string | null;
  replyToSeq: number | null;
}
export interface HelperNoteView {
  id: string;
  scope: "global" | "sidebar";
  roomId: string | null;
  role: "user" | "helper";
  text: string;
  at: string;
}

const SCHEMA = `CREATE TABLE IF NOT EXISTS gg_helper_notes (
  id TEXT PRIMARY KEY, scope TEXT NOT NULL, room_id TEXT, role TEXT NOT NULL, text TEXT NOT NULL, at TEXT NOT NULL, action_id TEXT NOT NULL UNIQUE
)`;
interface NoteRow {
  id: string;
  scope: "global" | "sidebar";
  room_id: string | null;
  role: "user" | "helper";
  text: string;
  at: string;
}
const view = (r: NoteRow): HelperNoteView => ({ id: r.id, scope: r.scope, roomId: r.room_id, role: r.role, text: r.text, at: r.at });

export class HelperDesk {
  private readonly host: Host;
  constructor(host: Host) {
    this.host = host;
    host.db.store.db.exec(SCHEMA);
  }

  /** 入口 → 路由(routeHelper:只为用户本人服务);带会话的入口要求用户在这个会话里。 */
  private route(entry: HelperEntryInput): HelperRouteView {
    const e: HelperEntry =
      entry.kind === "global" ? { kind: "global" } : entry.kind === "sidebar" ? { kind: "sidebar", conversationId: entry.roomId } : { kind: "mention", conversationId: entry.roomId, seq: entry.seq };
    const r = routeHelper(e, { kind: "user", id: this.host.userId }, this.host.userId);
    if (!r.ok) throw new HostError("invalid_params", r.reason);
    if (entry.kind !== "global") this.mustSee(entry.roomId);
    return { replyIn: r.route.replyIn, becomesMessage: r.route.becomesMessage, contextRoomId: r.route.contextConversation, replyToSeq: r.route.replyToSeq };
  }
  private mustSee(roomId: string) {
    this.host.roomView(roomId);
    if (!this.host.members(roomId).some((m) => m.kind === "user" && m.id === this.host.userId)) throw new HostError("forbidden", `你不在会话 ${roomId} 里,Helper 不能读它`);
  }

  /** 全局入口默认不读任何聊天,readRoomIds 按需点名;侧栏与 @ 只读当前聊天。 */
  context(entry: HelperEntryInput, readRoomIds: readonly string[] = [], limit = 100): { route: HelperRouteView; rooms: { roomId: string; title: string; messages: MessageView[] }[] } {
    const route = this.route(entry);
    if (entry.kind !== "global" && readRoomIds.some((x) => x !== route.contextRoomId)) throw new HostError("invalid_params", "侧栏和 @Helper 只读当前聊天;要读别的聊天请从全局入口点名");
    const ids = entry.kind === "global" ? [...new Set(readRoomIds)] : [route.contextRoomId!];
    for (const id of ids) this.mustSee(id);
    return { route, rooms: ids.map((id) => ({ roomId: id, title: this.host.roomView(id).title, messages: this.host.listMessages(id, { limit }).messages })) };
  }

  /** 全局面板 / 侧栏里记一条问答:不进会话、不送联系人。 */
  note(entry: HelperEntryInput, role: "user" | "helper", text: string, clientActionId: string): HelperNoteView {
    const route = this.route(entry);
    if (route.becomesMessage) throw new HostError("invalid_params", "@Helper 的回复用 helper.post 发进聊天");
    const key = `helper-note:${clientActionId}`;
    const prior = one<NoteRow>(this.host.db, "SELECT * FROM gg_helper_notes WHERE action_id = ?", key);
    if (prior) return view(prior);
    const row: NoteRow = { id: `hn-${randomUUID()}`, scope: entry.kind === "global" ? "global" : "sidebar", room_id: route.contextRoomId, role, text, at: new Date().toISOString() };
    run(this.host.db, "INSERT INTO gg_helper_notes (id, scope, room_id, role, text, at, action_id) VALUES (?, ?, ?, ?, ?, ?, ?)", row.id, row.scope, row.room_id, row.role, row.text, row.at, key);
    return view(row);
  }

  history(entry: HelperEntryInput, limit = 200): HelperNoteView[] {
    const route = this.route(entry);
    if (route.becomesMessage) throw new HostError("invalid_params", "@Helper 的回复在聊天里,用 messages.list 看");
    const rows =
      entry.kind === "global"
        ? all<NoteRow>(this.host.db, "SELECT * FROM (SELECT rowid AS r, * FROM gg_helper_notes WHERE scope = 'global' ORDER BY rowid DESC LIMIT ?) ORDER BY r", limit)
        : all<NoteRow>(this.host.db, "SELECT * FROM (SELECT rowid AS r, * FROM gg_helper_notes WHERE scope = 'sidebar' AND room_id = ? ORDER BY rowid DESC LIMIT ?) ORDER BY r", route.contextRoomId, limit);
    return rows.map(view);
  }

  /** 聊天里 @Helper 时的公开回复:只认用户 @Helper 的那条消息。 */
  post(entry: HelperEntryInput, text: string, clientActionId: string): MessageView {
    const route = this.route(entry);
    if (!route.becomesMessage || entry.kind !== "mention") throw new HostError("invalid_params", "只有聊天里 @Helper 的回复会发成会话消息;侧栏和全局面板用 helper.note");
    const asked = this.host.listMessages(entry.roomId, { afterSeq: entry.seq - 1, limit: 1 }).messages[0];
    if (!asked || asked.seq !== entry.seq || asked.sender.kind !== "user" || !asked.mentions.some((m) => m.id === HELPER_ID)) throw new HostError("invalid_params", `#${entry.seq} 不是用户 @Helper 的消息`);
    return this.host.postAsHelper(entry.roomId, HELPER_ID, text, entry.seq, clientActionId);
  }
}
