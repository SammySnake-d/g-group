// G1 的来源与消息版本规则，纯函数；I/O 与覆盖台账归宿主。
// statedIn / foldForMatch 改编自 OpenMausBot server/memory-capture.ts 与 memory-entries.ts
// @6c7bcb02ea766429091f94b8e1e11b7b3b8675af，Copyright 2026 Milind Soni and contributors，Apache-2.0。
// 本地增量：中文假设/问句尾、引用来源过滤。许可和归属见 third_party/openmausbot-memory/。
import type { CompactMemory, ReflectSource, ReflectResult } from "./runtime-ports.ts";
import { plainData } from "./plain.ts";
export type RevisionEvent = { readonly seq: number; readonly body: { readonly kind: string; readonly target?: number } };
export function messageRevision(events: readonly RevisionEvent[], seq: number): number { throw new Error("P1-A compile-only stub"); }
const foldForMatch = (text: string) => text.normalize("NFKC").toLowerCase().replace(/[‘’ʼ]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, " ").trim();
const SENTENCE_END = /[.!?\n。！？؟]/u;
const QUESTION = /[?？؟]/u;
const HYPOTHETICAL = /\b(?:suppose|supposing|imagine|pretend|hypothetical(?:ly)?|let'?s say|let us say|what if)\b/i;
const CHINESE_HYPOTHETICAL = /假如|假设|假使|设想|倘若|如果|假若/;
const CHINESE_QUESTION = /要不要|是不是|能不能|可不可以|是否|会怎样|会怎么样|(?:吗|么|呢|如何)[\s。！!]*$/;
export function statedIn(said: string, evidence: string): boolean { throw new Error("P1-A compile-only stub"); }
const LONG_TERM = /以后|所有|一律|始终|永远|每次|always|from now on/i;
function directLines(text: string): string[] { throw new Error("P1-A compile-only stub"); }
export type CaptureCheck = { ok: true; source: ReflectSource; anchors: readonly string[] } | { ok: false; reason: string };
export function validateCapture(candidate: CompactMemory, delivered: readonly ReflectSource[], current: readonly ReflectSource[]): CaptureCheck { throw new Error("P1-A compile-only stub"); }
export function decodeReflect(input: unknown): { ok: true; value: ReflectResult } | { ok: false; reason: string } { throw new Error("P1-A compile-only stub"); }
