// 状态笔记压缩器的 pi 实现。红提交:空壳。
import type { ContactCompactor } from "@g-group/kernel";
import type { PiContactMindOptions } from "./mind.ts";

export type PiCompactorOptions = Omit<PiContactMindOptions, "maxRequestsPerRound" | "cacheRetention">;
export function createPiCompactor(_opts: PiCompactorOptions): ContactCompactor {
  return { compact: async () => "" };
}
