// 转发选中消息与显式关联(U25 转发、U24 关联、US2;需求 D04 第 1 节、D06 第 3 节第 2 条、D28.6;验收 AC-20)。
// 空壳:签名在,实现在下一个提交。
import type { Db } from "./db.ts";

export interface ForwardItem {
  readonly seq: number;
  readonly sender: { readonly kind: "user" | "contact" | "helper"; readonly id: string };
  readonly senderName: string;
  readonly at: string;
  readonly text: string;
}
export interface ForwardRecord {
  readonly roomId: string;
  readonly seq: number;
  readonly fromRoomId: string;
  readonly fromTitle: string;
  readonly fromKind: "dm" | "group";
  readonly note: string | null;
  readonly items: readonly ForwardItem[];
}
export interface RoomLink {
  readonly roomId: string;
  readonly linkedRoomId: string;
  readonly uptoSeq: number;
  readonly linkedAt: string;
}

export class ForwardLinkStore {
  constructor(_db: Db) {}
  forwardOf(_roomId: string, _seq: number): ForwardRecord | null {
    return null;
  }
  linksOf(_roomId: string): RoomLink[] {
    return [];
  }
}
