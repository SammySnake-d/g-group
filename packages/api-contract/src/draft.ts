// 输入框草稿 ClientInputDraft[roomId](AC-24、AC-37 ①②):红提交空壳,签名在、返回假值,下一提交实现。
import type { Schema } from "./schema.ts";

export const DRAFT_MAX_QUOTES = 50;
export const DRAFT_MAX_MENTIONS = 100;
export const DRAFT_MAX_TEXT = 100000;

export interface DraftMention { id: string; source: "auto" | "manual" }
export interface DraftBody { text: string; replyToSeq: number | null; replyAuthorId: string | null; quotedSeqs: number[]; mentions: DraftMention[]; draftVer: number }
export interface DraftView extends DraftBody { roomId: string; updatedAt: string | null }
const unimplemented = <T>(): Schema<T> => ({ kind: "unimplemented", check: (_v, path = "") => ({ ok: false, issues: [{ path: path || "$", message: "未实现" }] }) });
export const DraftMention = unimplemented<DraftMention>();
export const DraftBody = unimplemented<DraftBody>();
export const DraftView = unimplemented<DraftView>();

export interface ClientInputDraft {
  readonly roomId: string;
  readonly text: string;
  readonly replyToSeq: number | null;
  readonly replyAuthorId: string | null;
  readonly quotedSeqs: readonly number[];
  readonly mentions: readonly DraftMention[];
  readonly draftVer: number;
}
export interface DraftAuthor { readonly kind: "user" | "contact" | "helper" | "system"; readonly id: string }
export type DraftOp =
  | { readonly op: "setText"; readonly text: string }
  | { readonly op: "reply"; readonly seq: number; readonly author: DraftAuthor }
  | { readonly op: "quote"; readonly seq: number }
  | { readonly op: "removeQuote"; readonly seq: number }
  | { readonly op: "mention"; readonly id: string }
  | { readonly op: "unmention"; readonly id: string; readonly source: DraftMention["source"] }
  | { readonly op: "clear" };
export interface DraftReceipt {
  readonly roomId: string;
  readonly submittedVer: number;
  readonly submitted: { readonly text: string; readonly replyToSeq: number | null; readonly quotedSeqs: readonly number[]; readonly mentions: readonly DraftMention[] };
}

export function draftIssues(_d: unknown): string[] {
  return [];
}
export function emptyDraft(roomId: string): ClientInputDraft {
  return { roomId, text: "", replyToSeq: null, replyAuthorId: null, quotedSeqs: [], mentions: [], draftVer: 0 };
}
export function applyDraft(d: ClientInputDraft, _op: DraftOp): ClientInputDraft {
  return d;
}
export function settleDraft(d: ClientInputDraft, _r: DraftReceipt): ClientInputDraft {
  return d;
}
export function isDraftEmpty(_d: ClientInputDraft): boolean {
  return false;
}
export function draftPreview(_d: ClientInputDraft): string | null {
  return null;
}
export function draftToSend(_d: ClientInputDraft): { text: string; replyToSeq: number | null; quotedSeqs: number[]; mentions: DraftMention[]; draftVer: number } {
  return { text: "", replyToSeq: null, quotedSeqs: [], mentions: [], draftVer: 0 };
}
