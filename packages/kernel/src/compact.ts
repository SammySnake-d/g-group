// 状态笔记压缩的纯函数(D06 第 2 小节第 3 块、D25 第 8 节)。红提交:空壳。
import type { Inbound, MindAction } from "./runtime-ports.ts";

export const RETRACT_MIN_CHARS = 0;
export function compactMaterial(_fresh: readonly Inbound[], _actions: readonly MindAction[]): string {
  return "";
}
export function scrubRetracted(note: string, _retracted: readonly string[]): { text: string; hits: number; leaked: boolean } {
  return { text: note, hits: 0, leaked: false };
}
