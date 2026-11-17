// 群公告(AC-55,U97/U86,D28 第 4 条):一个群可有多条公告,新增不覆盖旧的;撤下保留记录但不再显示和装配。
// 装配:联系人每轮第 1 块「群规快照」= 群规原文 + 当前全部有效公告(按 order 排),版本号 = rules_version + 公告修订号。
// 公告修订号 = 本群全部公告(含已撤下)的 version 之和:新增、改正文、撤下各 +1,别的操作不动它,
// 所以快照版本单调、内容不变时不变(U85/D22:只在公告真改了才换前缀)。
// 排序及消息置顶关系待定(D28 待确认 ④):排序先按创建先后,做成参数;消息置顶不会自动变成公告。
import type { AnnouncementView } from "@g-group/api-contract";
import { type Db, HostError, all, one, run, tx } from "./db.ts";

export type AnnouncementOrder = "created-asc" | "created-desc";
export interface AnnouncementDeps {
  readonly db: Db;
  readonly now: () => string;
  readonly newId: (prefix: string) => string;
  /** 默认排序(列表与装配共用)。 */
  readonly order: AnnouncementOrder;
  /** 会话种类;会话不存在时抛 not_found。 */
  readonly roomKind: (roomId: string) => "dm" | "group";
  /** 公告改动后推 room.updated。 */
  readonly changed: (roomId: string) => void;
}
interface Row {
  ord: number;
  id: string;
  room_id: string;
  text: string;
  version: number;
  client_action_id: string;
  created_at: string;
  updated_at: string;
  removed_at: string | null;
}

const view = (r: Row): AnnouncementView => ({ id: r.id, roomId: r.room_id, text: r.text, version: r.version, createdAt: r.created_at, updatedAt: r.updated_at });

/** 群规快照正文:群规原文 + 公告段(没有公告就不出公告段)。 */
export function composeRoomRules(rules: string, announcements: readonly { readonly text: string }[]): string {
  const parts = rules.trim() ? [rules] : [];
  if (announcements.length) parts.push(`群公告(共 ${announcements.length} 条):\n${announcements.map((a, i) => `${i + 1}. ${a.text}`).join("\n")}`);
  return parts.join("\n");
}

export class AnnouncementStore {
  private readonly d: AnnouncementDeps;
  constructor(deps: AnnouncementDeps) {
    this.d = deps;
  }
  private row(id: string): Row {
    const r = one<Row>(this.d.db, "SELECT * FROM gg_announcements WHERE id = ? AND removed_at IS NULL", id);
    if (!r) throw new HostError("not_found", `没有公告 ${id}`);
    return r;
  }
  private live(roomId: string, order: AnnouncementOrder): Row[] {
    return all<Row>(this.d.db, `SELECT * FROM gg_announcements WHERE room_id = ? AND removed_at IS NULL ORDER BY ord ${order === "created-desc" ? "DESC" : "ASC"}`, roomId);
  }
  private checkVersion(r: Row, expectedVersion: number | undefined) {
    if (expectedVersion !== undefined && expectedVersion !== r.version) throw new HostError("conflict", "公告已被别人改过", { currentVer: r.version });
  }
  /** 当前有效公告;私聊没有群公告,返回空数组。 */
  list(roomId: string, order?: AnnouncementOrder): AnnouncementView[] {
    if (this.d.roomKind(roomId) !== "group") return [];
    return this.live(roomId, order ?? this.d.order).map(view);
  }
  count(roomId: string): number {
    return one<{ n: number }>(this.d.db, "SELECT count(*) AS n FROM gg_announcements WHERE room_id = ? AND removed_at IS NULL", roomId)?.n ?? 0;
  }
  /** 本群公告修订号:全部公告(含已撤下)的 version 之和,任何一次新增、改正文、撤下都让它 +1。 */
  revision(roomId: string): number {
    return one<{ v: number | null }>(this.d.db, "SELECT sum(version) AS v FROM gg_announcements WHERE room_id = ?", roomId)?.v ?? 0;
  }
  /** 新增一条,不覆盖已有的;同一 clientActionId 重发返回原条目、不推事件。 */
  add(roomId: string, text: string, clientActionId: string): AnnouncementView {
    if (this.d.roomKind(roomId) !== "group") throw new HostError("forbidden", "私聊没有群公告");
    if (!text.trim()) throw new HostError("invalid_params", "公告不能为空");
    const prior = one<Row>(this.d.db, "SELECT * FROM gg_announcements WHERE room_id = ? AND client_action_id = ?", roomId, clientActionId);
    if (prior) return view(prior);
    const id = this.d.newId("ann");
    const at = this.d.now();
    run(this.d.db, "INSERT INTO gg_announcements (id, room_id, text, version, client_action_id, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?)", id, roomId, text, clientActionId, at, at);
    this.d.changed(roomId);
    return view(this.row(id));
  }
  /** 改正文(CAS);正文没变就原样返回,不升版本、不推事件,前缀缓存不失效。 */
  update(id: string, text: string, expectedVersion?: number): AnnouncementView {
    if (!text.trim()) throw new HostError("invalid_params", "公告不能为空");
    const r = tx(this.d.db, () => {
      const cur = this.row(id);
      this.checkVersion(cur, expectedVersion);
      if (cur.text === text) return { row: cur, changed: false };
      run(this.d.db, "UPDATE gg_announcements SET text = ?, version = version + 1, updated_at = ? WHERE id = ?", text, this.d.now(), id);
      return { row: this.row(id), changed: true };
    });
    if (r.changed) this.d.changed(r.row.room_id);
    return view(r.row);
  }
  /** 撤下(CAS):保留记录,版本 +1,不再显示和装配。 */
  remove(id: string, expectedVersion?: number): void {
    const roomId = tx(this.d.db, () => {
      const cur = this.row(id);
      this.checkVersion(cur, expectedVersion);
      const at = this.d.now();
      run(this.d.db, "UPDATE gg_announcements SET removed_at = ?, version = version + 1, updated_at = ? WHERE id = ?", at, at, id);
      return cur.room_id;
    });
    this.d.changed(roomId);
  }
  /** 给装配的群规快照:群规原文 + 当前有效公告;version = 群规版本 + 公告修订号(单调,内容不变时不变)。 */
  snapshot(roomId: string, rules: string, rulesVersion: number): { rules: string; version: number } {
    const anns = this.d.roomKind(roomId) === "group" ? this.live(roomId, this.d.order) : [];
    return { rules: composeRoomRules(rules, anns), version: rulesVersion + this.revision(roomId) };
  }
}
