// 只追加的会话记录(AC-05)与发言者约束(AC-03)。—— 红提交:空壳
import type { DomainError } from "./errors.ts";

export type SenderKind = "user" | "contact" | "helper";
export interface Sender { kind: SenderKind; id: string }
export type EventBody =
  | { kind: "message"; text: string }
  | { kind: "edit"; target: number; text: string }
  | { kind: "retract"; target: number };
export interface LogEvent { seq: number; at: string; sender: Sender; body: EventBody; prev: string; hash: string }
export interface Log { readonly events: readonly LogEvent[] }
export interface ProjectedMessage { seq: number; sender: Sender; text: string; edited: boolean; retracted: boolean }
export type VerifyResult = { ok: true } | { ok: false; brokenAt: number };
export type { DomainError };

export function emptyLog(): Log { throw new Error("未实现"); }
export function append(_log: Log, _sender: { kind: string; id: string }, _body: EventBody, _at: string): Log { throw new Error("未实现"); }
export function verify(_log: Log): VerifyResult { throw new Error("未实现"); }
export function project(_log: Log): ProjectedMessage[] { throw new Error("未实现"); }
