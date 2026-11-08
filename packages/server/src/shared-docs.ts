// 共享文档单一提交点(AC-21):空壳(先红)。签名就位,返回假值。
import type { SharedDocVersionView, SharedDocView } from "@g-group/api-contract";
import type { Db } from "./db.ts";

export type DocMember = { kind: "user" | "contact"; id: string };
export interface CommitInput {
  readonly docId: string;
  readonly baseVersion: number;
  readonly content: string;
  readonly requestId: string;
  readonly title?: string;
}
export interface CommitOutcome {
  readonly doc: SharedDocView;
  readonly committedVersion: number;
  readonly replayed: boolean;
}
export interface SharedDocsDeps {
  readonly db: Db;
  readonly dataDir: string;
  readonly now: () => string;
  readonly newId: (prefix: string) => string;
  readonly checkRoom: (roomId: string) => void;
  readonly emit: (doc: SharedDocView) => void;
  readonly onReport?: (what: string, detail: unknown) => void;
}
const FAKE: SharedDocView = { id: "", roomId: null, title: "", content: "", version: 0, createdAt: "", updatedAt: "", updatedBy: { kind: "user", id: "" } };

export class SharedDocs {
  constructor(_d: SharedDocsDeps) {}
  mirrorPath(_docId: string): string {
    return "";
  }
  repairMirrors(): number {
    return 0;
  }
  create(_input: { clientActionId: string; title: string; content: string; roomId?: string | null }, _by: DocMember): SharedDocView {
    return FAKE;
  }
  commit(_input: CommitInput, _by: DocMember): CommitOutcome {
    return { doc: FAKE, committedVersion: 0, replayed: false };
  }
  get(_docId: string, _version?: number): SharedDocView {
    return FAKE;
  }
  list(_q: { roomId?: string }): SharedDocView[] {
    return [];
  }
  history(_docId: string, _limit = 50): SharedDocVersionView[] {
    return [];
  }
}
