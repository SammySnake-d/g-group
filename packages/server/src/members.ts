// 群成员移出(AC-49,U03/U09,D05):移出在这个群有在途任务的联系人时先进「移出中」——这个群的新消息不再送达它,
// 它在这个群的发言、登记承诺与接新活被拒;它在这个群的在途任务走状态机 Cancel → 停 Compute;
// 只有每个任务都收到真实停止确认(Compute 的 stopped/failed 把任务推到 T10/T11)之后,才真正删成员行。
// 群临时算力池还没有实现:这里只是「停止确认后才释放」的底座;状态机在 StoppedConfirmed 时给出的 release-slot 是将来归还槽位的接点。
// D05 的「交接 / 继续至检查点」两个选项是候选,本片只做停止。
import type { MemberRef } from "@g-group/api-contract";
import type { Db } from "./db.ts";

/** 不再算在途的任务状态:已交付待确认/已验收(T8)、已取消(T10)、已失败(T11)。 */
export const EXIT_SETTLED: ReadonlySet<string> = new Set(["T8a_Delivered", "T8_Accepted", "T10_Cancelled", "T11_Failed"]);
/** 移出中的成员在这个群里提出的动作被拒时记的原因。 */
export const LEAVING_REASON = "正在移出这个群,不能在这里发言或接新活";

export class MemberExits {
  readonly db: Db;
  readonly now: () => string;
  constructor(deps: { readonly db: Db; readonly now: () => string }) {
    this.db = deps.db;
    this.now = deps.now;
  }
  isLeaving(_roomId: string, _contactId: string): boolean {
    throw new Error("未实现");
  }
  leavingIn(_roomId: string): MemberRef[] {
    throw new Error("未实现");
  }
  leavingRoomsOf(_contactId: string): Set<string> {
    throw new Error("未实现");
  }
  begin(_roomId: string, _contactId: string): void {
    throw new Error("未实现");
  }
  finishTx(_roomId: string, _contactId: string): void {
    throw new Error("未实现");
  }
}
