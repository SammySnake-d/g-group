// 联系人的 progress_get(需求文档 D26 第 4 节,AC-43 ①④、U91):空壳,签名在、返回假值。
import type { RunStore } from "./runs.ts";

export const PROGRESS_GET_MAX_CHILDREN = 20;
export const PROGRESS_GET_MAX_EVENTS = 10;

export function progressGet(_runs: RunStore, _contactId: string, _rooms: readonly { readonly id: string; readonly kind: string }[], _roomId: string, _id: string): string | null {
  return null;
}
