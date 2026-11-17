// 群成员移出(AC-49,U03/U09,D05):移出在这个群有在途任务的联系人时先进「移出中」——这个群的新消息不再送达它,
// 它在这个群的发言、登记承诺与接新活被拒;它在这个群的在途任务走状态机 Cancel → 停 Compute;
// 只有每个任务都收到真实停止确认(Compute 的 stopped/failed 把任务推到 T10/T11)之后,才真正删成员行。
// 群临时算力池还没有实现:这里只是「停止确认后才释放」的底座;状态机在 StoppedConfirmed 时给出的 release-slot 是将来归还槽位的接点。
// D05 的「交接 / 继续至检查点」两个选项是候选,本片只做停止。
import type { MemberRef } from "@g-group/api-contract";
import { type Db, all, one, run } from "./db.ts";

/** 不再算在途的任务状态:已交付待确认/已验收(T8)、已取消(T10)、已失败(T11)。 */
export const EXIT_SETTLED: ReadonlySet<string> = new Set(["T8a_Delivered", "T8_Accepted", "T10_Cancelled", "T11_Failed"]);
/** 移出中的成员在这个群里提出的动作被拒时记的原因。 */
export const LEAVING_REASON = "正在移出这个群,不能在这里发言或接新活";

export class MemberExits {
  private readonly db: Db;
  private readonly now: () => string;
  constructor(deps: { readonly db: Db; readonly now: () => string }) {
    this.db = deps.db;
    this.now = deps.now;
  }
  isLeaving(roomId: string, contactId: string): boolean {
    return !!one(this.db, "SELECT 1 FROM gg_member_exits WHERE room_id = ? AND contact_id = ?", roomId, contactId);
  }
  /** 这个群里移出中的成员(按开始先后)。 */
  leavingIn(roomId: string): MemberRef[] {
    return all<{ contact_id: string }>(this.db, "SELECT contact_id FROM gg_member_exits WHERE room_id = ? ORDER BY started_at, contact_id", roomId).map((r) => ({ kind: "contact", id: r.contact_id }));
  }
  /** 这位联系人正在移出的群。 */
  leavingRoomsOf(contactId: string): Set<string> {
    return new Set(all<{ room_id: string }>(this.db, "SELECT room_id FROM gg_member_exits WHERE contact_id = ?", contactId).map((r) => r.room_id));
  }
  begin(roomId: string, contactId: string): void {
    run(this.db, "INSERT OR IGNORE INTO gg_member_exits (room_id, contact_id, started_at) VALUES (?, ?, ?)", roomId, contactId, this.now());
  }
  /** 删成员行、游标与移出标记(在事务里调用)。 */
  finishTx(roomId: string, contactId: string): void {
    run(this.db, "DELETE FROM gg_members WHERE room_id = ? AND kind = 'contact' AND member_id = ?", roomId, contactId);
    run(this.db, "DELETE FROM gg_cursor WHERE room_id = ? AND contact_id = ?", roomId, contactId);
    run(this.db, "DELETE FROM gg_member_exits WHERE room_id = ? AND contact_id = ?", roomId, contactId);
  }
}
