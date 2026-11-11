// 记忆与状态笔记的撤回 / 回退清洗(验收 AC-08 记忆与笔记侧、AC-42 ⑤⑧;需求 U29、D06 §1、D25 §4)。红提交:只有空壳,签名在、返回假值。
import type { MemoryEntry } from "@g-group/kernel";
import type { Db } from "./db.ts";
import { MemoryStore } from "./memory-store.ts";

export class HygienicMemoryStore extends MemoryStore {
  readonly now: () => string;
  constructor(db: Db, root: string, report: (what: string, detail: unknown) => void, now: () => string) {
    super(db, root, report);
    this.now = now;
  }
  hiddenIds(_entries: readonly MemoryEntry[]) {
    return new Set<string>();
  }
  listAll(contactId: string): MemoryEntry[] {
    return super.list(contactId);
  }
  checkIndex() {}
}

export function purgeHiddenPrefix(_db: Db, _contactId: string, _store: HygienicMemoryStore): void {}

export function rewoundTexts(_db: Db, _roomIds: readonly string[]): string[] {
  return [];
}

export function rescrubNotes(_db: Db, _contactIds: readonly string[], _scrub: (contactId: string, text: string) => string): void {}
