// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Milind Soni and OpenMausBot contributors
// Adapted from milind-soni/OpenMausBot (613ed01fd), licensed under Apache-2.0.

export const EXCERPT_SUMMARY_HEADER = "Historical excerpts in chronological order; newer corrections override older requests. These excerpts may omit earlier details.";
export interface ReplayEntry { readonly id: string; readonly role: "user" | "assistant"; readonly text: string }
export interface DraftSummaryOptions {
  generateText?: (prompt: string, options?: { signal?: AbortSignal }) => Promise<string>;
  signal: AbortSignal;
  timeoutMs?: number;
}
export function foldPoint(_history: readonly ReplayEntry[], _keepExchanges = 2): { folded: ReplayEntry[]; firstKeptId: string } | null { return null; }
export function deterministicSummary(_history: readonly ReplayEntry[], _maxBytes?: number): string { return ""; }
export function summaryPrompt(_history: readonly ReplayEntry[]): string { return ""; }
export async function draftSummary(_history: readonly ReplayEntry[], _options: DraftSummaryOptions): Promise<string> { return ""; }
