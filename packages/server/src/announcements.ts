// 群公告(AC-55,U97/U86,D28 第 4 条):一个群可有多条公告,新增不覆盖旧的;撤下保留记录但不再显示和装配。
// 装配:联系人每轮第 1 块「群规快照」= 群规原文 + 当前全部有效公告(按 order 排),版本号 = rules_version + 公告修订号。
// 公告修订号 = 本群全部公告(含已撤下)的 version 之和:新增、改正文、撤下各 +1,别的操作不动它,
// 所以快照版本单调、内容不变时不变(U85/D22:只在公告真改了才换前缀)。
// 排序及消息置顶关系待定(D28 待确认 ④):排序先按创建先后,做成参数;消息置顶不会自动变成公告。
import type { AnnouncementView } from "@g-group/api-contract";
import type { Db } from "./db.ts";

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
/** 群规快照正文:群规原文 + 公告段(没有公告就不出公告段)。 */
export function composeRoomRules(_rules: string, _announcements: readonly { readonly text: string }[]): string {
  throw new Error("未实现");
}

export class AnnouncementStore {
  readonly d: AnnouncementDeps;
  constructor(deps: AnnouncementDeps) {
    this.d = deps;
  }
  list(_roomId: string, _order?: AnnouncementOrder): AnnouncementView[] {
    throw new Error("未实现");
  }
  count(_roomId: string): number {
    throw new Error("未实现");
  }
  revision(_roomId: string): number {
    throw new Error("未实现");
  }
  add(_roomId: string, _text: string, _clientActionId: string): AnnouncementView {
    throw new Error("未实现");
  }
  update(_id: string, _text: string, _expectedVersion?: number): AnnouncementView {
    throw new Error("未实现");
  }
  remove(_id: string, _expectedVersion?: number): void {
    throw new Error("未实现");
  }
  snapshot(_roomId: string, _rules: string, _rulesVersion: number): { rules: string; version: number } {
    throw new Error("未实现");
  }
}
