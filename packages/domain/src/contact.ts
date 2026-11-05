// 联系人(AC-01 / AC-33 / 概念卡第 1、11 张)与 Helper 三种入口(用户 g-group#1365)。—— 红提交:空壳
export interface NamedTool { name: string; bounded: true }
export type Placement = "local" | "byom_daemon" | "cloud_sandbox";
export interface Schedule { cron: string; tz: string; toleranceSec: number }
export interface Commitment {
  id: string; sourceSeq: number; text: string; boundTaskIds: readonly string[];
  schedule: Schedule | null; status: "active" | "done" | "revoked";
}
export interface FocusPolicy { onlyCommitmentId: string }
export interface Contact {
  readonly id: string; readonly name: string; readonly speakingModel: string;
  readonly tools: readonly NamedTool[]; readonly memory: string; readonly soul: string;
  readonly commitments: readonly Commitment[]; readonly focus: FocusPolicy | null;
}
export type ContactResult = { ok: true; contact: Contact } | { ok: false; reason: string };
export interface Directory { readonly contacts: ReadonlyMap<string, Contact> }
export type DirectoryResult = { ok: true; dir: Directory } | { ok: false; reason: string };
export const FORBIDDEN_DIRECT_TOOLS: readonly string[] = [];
export interface ComputeBrief { task: string; rules: readonly string[]; tools: readonly string[]; credentialRefs: readonly string[]; placement: Placement }
export type BriefResult = { ok: true; brief: ComputeBrief } | { ok: false; reason: string };
export type InboundIntent = { kind: "control"; action: "stop" | "revoke" | "reschedule"; commitmentId: string } | { kind: "work"; text: string } | { kind: "chatter"; text: string };
export type FocusDecision = "handle" | "decline-focused" | "ignore";

export function emptyDirectory(): Directory { throw new Error("未实现"); }
export function addContact(_d: Directory, _c: { id: string; name: string; speakingModel: string }): DirectoryResult { throw new Error("未实现"); }
export function updateContact(_d: Directory, _id: string, _patch: Partial<Pick<Contact, "name" | "speakingModel" | "memory">>): DirectoryResult { throw new Error("未实现"); }
export function grantTool(_c: Contact, _tool: { name: string; bounded: boolean }): ContactResult { throw new Error("未实现"); }
export function commit(_c: Contact, _k: Omit<Commitment, "status">): ContactResult { throw new Error("未实现"); }
export function settleTask(_c: Contact, _taskId: string): Contact { throw new Error("未实现"); }
export function setFocus(_c: Contact, _f: FocusPolicy | null): ContactResult { throw new Error("未实现"); }
export function decideUnderFocus(_c: Contact, _i: InboundIntent): FocusDecision { throw new Error("未实现"); }
export function briefFor(_c: Contact, _r: { task: string; rules: readonly string[]; tools: readonly string[]; credentialRefs: readonly string[]; placement?: Placement }): BriefResult { throw new Error("未实现"); }
