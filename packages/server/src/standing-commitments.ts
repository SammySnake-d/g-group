// 联系人自设定时与常驻承诺(U20、U80、D04.2-1;D02 窄接口形态是候选,待用户定)。空壳:签名在,返回假值。
import type { InboundMessage, MindAction } from "@g-group/kernel";
import type { Db } from "./db.ts";

export type ScheduleAction = Extract<MindAction, { kind: "schedule-set" | "schedule-pause" | "schedule-remove" }>;
export interface StandingDeps {
  readonly db: Db;
  readonly now: () => string;
  readonly newId: (p: string) => string;
  readonly userId: string;
  readonly timezone: () => string;
}
export type StandingOutcome =
  | { readonly ok: false; readonly reason: string }
  | {
      readonly ok: true;
      readonly propose: { readonly id: string; readonly taskId: string; readonly text: string } | null;
      readonly close: { readonly commitmentId: string; readonly taskId: string; readonly detail: string } | null;
      readonly after: () => void;
    };

/** 用户本人的话:去掉引用块(> 开头的行)与代码块。 */
export function ownWords(text: string): string {
  return text;
}

export class StandingCommitments {
  constructor(_deps: StandingDeps) {}
  applyTx(_contactId: string, _a: ScheduleAction, _fresh: readonly InboundMessage[]): StandingOutcome {
    return { ok: false, reason: "未实现" };
  }
  countTx(_roomId: string, _seq: number, _sender: { kind: string; id: string }, _f: { card: boolean }): void {}
  takeNotify(): string[] {
    return [];
  }
  closedTx(_commitmentId: string): void {}
  takeChanged(): string[] {
    return [];
  }
  pointers(_contactId: string, _roomIds: readonly string[]): { ref: string; text: string }[] {
    return [];
  }
  listText(_contactId: string, _roomId: string): string | null {
    return null;
  }
}
