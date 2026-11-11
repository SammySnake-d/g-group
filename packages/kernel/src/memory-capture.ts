// G1 的来源与消息版本规则，纯函数；I/O 与覆盖台账归宿主。
// statedIn / foldForMatch 改编自 OpenMausBot server/memory-capture.ts 与 memory-entries.ts
// @6c7bcb02ea766429091f94b8e1e11b7b3b8675af，Copyright 2026 Milind Soni and contributors，Apache-2.0。
// 本地增量：中文假设/问句尾、引用来源过滤。许可和归属见 third_party/openmausbot-memory/。
import type { CompactMemory, RefineResult, ReflectSource, ReflectResult } from "./runtime-ports.ts";
import { plainData } from "./plain.ts";
export type RevisionEvent = { readonly seq: number; readonly body: { readonly kind: string; readonly target?: number } };
export function messageRevision(events: readonly RevisionEvent[], seq: number): number {
  return events.reduce((rev, e) => (e.body.kind === "edit" || e.body.kind === "retract") && e.body.target === seq ? Math.max(rev, e.seq) : rev, seq);
}
const foldForMatch = (text: string) => text.normalize("NFKC").toLowerCase().replace(/[‘’ʼ]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, " ").trim();
const SENTENCE_END = /[.!?\n。！？؟]/u;
const QUESTION = /[?？؟]/u;
const HYPOTHETICAL = /\b(?:suppose|supposing|imagine|pretend|hypothetical(?:ly)?|let'?s say|let us say|what if)\b/i;
const CHINESE_HYPOTHETICAL = /假如|假设|假使|设想|倘若|如果|假若/;
const CHINESE_QUESTION = /要不要|是不是|能不能|可不可以|是否|会怎样|会怎么样|(?:吗|么|呢|如何)[\s。！!]*$/;
export function statedIn(said: string, evidence: string): boolean {
  const text = foldForMatch(said);
  const quote = foldForMatch(evidence).replace(/[\s.!]+$/, "");
  const at = quote.length >= 3 ? text.indexOf(quote) : -1;
  if (at < 0 || QUESTION.test(quote)) return false;
  let start = at;
  while (start > 0 && !SENTENCE_END.test(text[start - 1]!)) start--;
  const rest = text.slice(at + quote.length);
  const stop = rest.search(SENTENCE_END);
  const sentence = text.slice(start, at + quote.length + (stop < 0 ? rest.length : stop + 1));
  return !QUESTION.test(sentence.slice(-1)) && !HYPOTHETICAL.test(sentence) && !CHINESE_HYPOTHETICAL.test(sentence) && !CHINESE_QUESTION.test(sentence);
}
const LONG_TERM = /以后|所有|一律|始终|永远|每次|always|from now on/i;
function directLines(text: string): string[] {
  // 抽出非引用、非代码块的直接发言行，唯一声明判定仍由 statedIn 完成。
  let inCode = false; const lines: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) { inCode = !inCode; continue; }
    if (inCode || /^\s*>/.test(line) || /(?:网页|网站|工具|文档|他说|她说|对方|模型|助手).{0,12}(?:写道|说|输出|显示|内容|要求|：|:)/.test(line) || /[“「『"].*[”」』"]/.test(line)) continue;
    lines.push(line);
  }
  return lines;
}
export type CaptureCheck = { ok: true; source: ReflectSource; anchors: readonly string[] } | { ok: false; reason: string };
export function validateCapture(candidate: CompactMemory, delivered: readonly ReflectSource[], current: readonly ReflectSource[]): CaptureCheck {
  const no = (reason: string): CaptureCheck => ({ ok: false, reason });
  if (!candidate.roomId || !Number.isSafeInteger(candidate.sourceSeq) || !candidate.evidence?.trim()) return no("缺少逐条 roomId/sourceSeq/evidence");
  const src = delivered.find(s => s.roomId === candidate.roomId && s.seq === candidate.sourceSeq);
  if (!src) return no("来源不属于本批实际投递材料");
  const visible = current.find(s => s.roomId === src.roomId && s.seq === src.seq);
  if (!visible || visible.revision !== src.revision || visible.text !== src.text || visible.senderKind !== src.senderKind || visible.senderId !== src.senderId) return no("来源已编辑、撤回或不可访问");
  if (src.senderKind !== "user" && !(candidate.kind === "outcome" && src.verifiedOutcome && visible.verifiedOutcome)) return no("非用户原话只收已验证结果");
  if (candidate.anchors.some(a => a.startsWith("user:") && a !== `user:${src.senderId}`)) return no("原作者不能替另一用户作证");
  if (!src.text.includes(candidate.evidence) || !directLines(src.text).some(line => line.includes(candidate.evidence!) && statedIn(line, candidate.evidence!))) return no("原话不是直接声明，或属于引用、问句、假设句");
  let anchors = [...new Set(candidate.anchors)];
  if (anchors.includes("global") && !(src.senderKind === "user" && LONG_TERM.test(candidate.evidence))) anchors = [...new Set([...anchors.filter(a => a !== "global"), `room:${src.roomId}`])];
  return { ok: true, source: src, anchors };
}
export function decodeReflect(input: unknown): { ok: true; value: ReflectResult } | { ok: false; reason: string } {
  const p = plainData(input, "reflect");
  if (!p.ok) return { ok: false, reason: `${p.path}:${p.why}` };
  const no = (reason: string) => ({ ok: false as const, reason });
  if (!p.value || typeof p.value !== "object" || Array.isArray(p.value)) return no("检查结果必须是对象");
  const r = p.value as Record<string, unknown>;
  const str = (s: unknown): s is string => typeof s === "string" && s.trim().length > 0;
  if (r.note !== null && !str(r.note)) return no("note 必须是非空字符串或 null");
  if (!Array.isArray(r.memories)) return no("memories 必须是数组");
  if (r.personaSuggestion !== null && r.personaSuggestion !== undefined && !str(r.personaSuggestion)) return no("personaSuggestion 不合法");
  const memories: CompactMemory[] = [];
  for (const item of r.memories) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return no("记忆项必须是对象");
    const m = item as Record<string, unknown>;
    if (!str(m.title) || !str(m.text) || !Array.isArray(m.anchors) || m.anchors.length === 0 || !m.anchors.every(str)) return no("记忆 title/text/anchors 不合法");
    if (m.relation != null && !["change", "refine", "conflict"].includes(String(m.relation))) return no("关系不合法");
    if (m.target != null && !str(m.target)) return no("target 不合法");
    if (m.roomId !== undefined && !str(m.roomId)) return no("roomId 不合法");
    if (m.sourceSeq !== undefined && (!Number.isSafeInteger(m.sourceSeq) || (m.sourceSeq as number) < 1)) return no("sourceSeq 不合法");
    if (m.evidence !== undefined && !str(m.evidence)) return no("evidence 不合法");
    if (m.kind !== undefined && !["preference", "fact", "decision", "outcome"].includes(String(m.kind))) return no("记忆 kind 不合法");
    memories.push({ title: m.title, text: m.text, anchors: [...m.anchors] as string[], relation: (m.relation ?? null) as CompactMemory["relation"], target: (m.target ?? null) as string | null, ...(m.roomId !== undefined ? { roomId: m.roomId as string } : {}), ...(m.sourceSeq !== undefined ? { sourceSeq: m.sourceSeq as number } : {}), ...(m.evidence !== undefined ? { evidence: m.evidence as string } : {}), ...(m.kind !== undefined ? { kind: m.kind as NonNullable<CompactMemory["kind"]> } : {}) });
  }
  return { ok: true, value: { note: r.note as string | null, memories, personaSuggestion: (r.personaSuggestion ?? null) as string | null } };
}
/** G5 精筛结果解码(红提交:空壳) */
export function decodeRefine(_input: unknown): { ok: true; value: RefineResult } | { ok: false; reason: string } {
  return { ok: false, reason: "未实现" };
}
export const isLongTerm = (evidence: string) => LONG_TERM.test(evidence);
