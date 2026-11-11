// Helper「脑子」的 pi 实现(AC-52,U04;D07.0 Helper 专属 MCP)。空壳:待实现。
import type { HelperMind } from "@g-group/kernel";
import type { PiContactMindOptions } from "./mind.ts";

export type PiHelperMindOptions = Omit<PiContactMindOptions, "cacheRetention">;

export function createPiHelperMind(_opts: PiHelperMindOptions): HelperMind {
  return Object.freeze({ run: async () => ({ reply: "", calls: [] }) });
}
