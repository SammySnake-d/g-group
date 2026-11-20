/* harness 原始会话(Claude Code / Codex 的对话记录)的类型与纯逻辑。
   Compute 是联系人分出去干活的执行体,背后是一个具体的 harness 会话;界面要能「打开会话」只读地看它的原始对话流(#1005)。
   后端合同目前只有 tasks.progress 的语义进度,没有原始记录:这里先按「将来按 computeId 分页取原始事件」定类型,
   演示数据和以后的接口都喂同一套类型,渲染层只认这里的分组结果。
   不放 token、上下文占比、花费(#877:要专门做计费与 token 统计才有,先不放)。 */

export type HarnessId = "claude-code" | "codex";

export const TOOL_KINDS = ["edit", "command", "read", "search", "web", "other"] as const;
export type ToolKind = (typeof TOOL_KINDS)[number];

export interface FileChange {
  path: string;
  added: number;
  removed: number;
}

interface EventBase {
  id: string;
  seq: number;
  at: string;
}

export interface PromptEvent extends EventBase {
  kind: "prompt";
  from: string;
  text: string;
}

export interface TextEvent extends EventBase {
  kind: "text";
  text: string;
}

export type ToolStatus = "running" | "ok" | "failed";

export interface ToolEvent extends EventBase {
  kind: "tool";
  name: string;
  summary: string;
  input?: string;
  output?: string;
  status: ToolStatus;
  durationMs?: number;
  changes?: FileChange[];
  retryOf?: string;
}

export type AgentStatus = "running" | "done" | "failed";

export interface AgentEvent extends EventBase {
  kind: "agent";
  label: string;
  brief: string;
  status: AgentStatus;
  calls: number;
  durationMs: number;
  result?: string;
  trail?: ToolEvent[];
}

export interface NoticeEvent extends EventBase {
  kind: "notice";
  level: "info" | "warn" | "error";
  text: string;
}

export interface DeliverableEvent extends EventBase {
  kind: "deliverable";
  name: string;
  type: "file" | "diff" | "link" | "text";
  ref: string;
  size?: string;
}

export type TranscriptEvent = PromptEvent | TextEvent | ToolEvent | AgentEvent | NoticeEvent | DeliverableEvent;

export interface BackgroundJob {
  id: string;
  command: string;
  state: "running" | "done" | "failed" | "killed";
}

export interface HarnessSessionMeta {
  computeId: string;
  harness: HarnessId;
  model: string;
  nativeSessionId: string | null;
  startedAt: string;
  endedAt: string | null;
  turns: number;
  background: BackgroundJob[];
}

export interface HarnessTranscript {
  meta: HarnessSessionMeta;
  events: TranscriptEvent[];
  hasEarlier: boolean;
}


const KIND_BY_TOOL: Record<string, ToolKind> = {
  edit: "edit",
  multiedit: "edit",
  write: "edit",
  notebookedit: "edit",
  apply_patch: "edit",
  bash: "command",
  shell: "command",
  exec_command: "command",
  bashoutput: "command",
  killshell: "command",
  read: "read",
  read_file: "read",
  ls: "read",
  view_image: "read",
  grep: "search",
  glob: "search",
  webfetch: "web",
  websearch: "web",
  web_search: "web",
  browser: "web",
};

export function toolKind(name: string): ToolKind {
  return KIND_BY_TOOL[name.trim().toLowerCase()] ?? "other";
}

export function digest(output: string | undefined, max = 80): string {
  const line = (output ?? "").split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  const chars = Array.from(line);
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : line;
}


export interface ToolCallView {
  event: ToolEvent;
  kind: ToolKind;
  attempt: number;
  recovered: boolean;
}

export type ToolTally = Record<ToolKind, number> & { added: number; removed: number };

export type TranscriptBlock =
  | { type: "prompt"; key: string; event: PromptEvent }
  | { type: "text"; key: string; event: TextEvent }
  | { type: "notice"; key: string; event: NoticeEvent }
  | { type: "tools"; key: string; calls: ToolCallView[]; tally: ToolTally; failed: number; recovered: number; running: boolean }
  | { type: "agents"; key: string; agents: AgentEvent[]; running: number; done: number; failed: number };

const bySeq = (a: { seq: number }, b: { seq: number }) => a.seq - b.seq;

export function tallyTools(calls: readonly ToolEvent[]): ToolTally {
  const t: ToolTally = { edit: 0, command: 0, read: 0, search: 0, web: 0, other: 0, added: 0, removed: 0 };
  for (const c of calls) {
    t[toolKind(c.name)] += 1;
    if (c.status !== "ok") continue;
    for (const ch of c.changes ?? []) {
      t.added += ch.added;
      t.removed += ch.removed;
    }
  }
  return t;
}

function retryIndex(tools: readonly ToolEvent[]) {
  const byId = new Map(tools.map((t) => [t.id, t]));
  const attempt = new Map<string, number>();
  const attemptOf = (t: ToolEvent, guard = 0): number => {
    const known = attempt.get(t.id);
    if (known !== undefined) return known;
    const prev = t.retryOf ? byId.get(t.retryOf) : undefined;
    const n = prev && guard < tools.length ? attemptOf(prev, guard + 1) + 1 : 1;
    attempt.set(t.id, n);
    return n;
  };
  const next = new Map<string, ToolEvent[]>();
  for (const t of tools) if (t.retryOf) next.set(t.retryOf, [...(next.get(t.retryOf) ?? []), t]);
  const recovered = (id: string, seen = new Set<string>()): boolean => {
    if (seen.has(id)) return false;
    seen.add(id);
    return (next.get(id) ?? []).some((r) => r.status === "ok" || recovered(r.id, seen));
  };
  return { attemptOf, recovered };
}

export function groupTranscript(events: readonly TranscriptEvent[]): TranscriptBlock[] {
  const sorted = [...events].sort(bySeq);
  const idx = retryIndex(sorted.filter((e): e is ToolEvent => e.kind === "tool"));
  const blocks: TranscriptBlock[] = [];
  for (const e of sorted) {
    const last = blocks[blocks.length - 1];
    if (e.kind === "tool") {
      const view: ToolCallView = { event: e, kind: toolKind(e.name), attempt: idx.attemptOf(e), recovered: e.status === "failed" && idx.recovered(e.id) };
      if (last?.type === "tools") last.calls.push(view);
      else blocks.push({ type: "tools", key: e.id, calls: [view], tally: tallyTools([]), failed: 0, recovered: 0, running: false });
    } else if (e.kind === "agent") {
      if (last?.type === "agents") last.agents.push(e);
      else blocks.push({ type: "agents", key: e.id, agents: [e], running: 0, done: 0, failed: 0 });
    } else if (e.kind === "prompt") blocks.push({ type: "prompt", key: e.id, event: e });
    else if (e.kind === "text") blocks.push({ type: "text", key: e.id, event: e });
    else if (e.kind === "notice") blocks.push({ type: "notice", key: e.id, event: e });
    /* 交付不放进对话流,单独收在「本轮交付」 */
  }
  for (const b of blocks) {
    if (b.type === "tools") {
      b.tally = tallyTools(b.calls.map((c) => c.event));
      b.failed = b.calls.filter((c) => c.event.status === "failed").length;
      b.recovered = b.calls.filter((c) => c.recovered).length;
      b.running = b.calls.some((c) => c.event.status === "running");
    } else if (b.type === "agents") {
      b.running = b.agents.filter((a) => a.status === "running").length;
      b.done = b.agents.filter((a) => a.status === "done").length;
      b.failed = b.agents.filter((a) => a.status === "failed").length;
    }
  }
  return blocks;
}


function allTools(events: readonly TranscriptEvent[]): ToolEvent[] {
  const out: ToolEvent[] = [];
  for (const e of events) {
    if (e.kind === "tool") out.push(e);
    else if (e.kind === "agent") out.push(...(e.trail ?? []));
  }
  return out;
}

/** 改动文件:同一路径多次修改合并;只算成功的调用;按第一次改到的顺序 */
export function changedFiles(events: readonly TranscriptEvent[]): FileChange[] {
  const map = new Map<string, FileChange>();
  for (const t of [...allTools(events)].sort(bySeq)) {
    if (t.status !== "ok") continue;
    for (const ch of t.changes ?? []) {
      const cur = map.get(ch.path);
      if (cur) {
        cur.added += ch.added;
        cur.removed += ch.removed;
      } else map.set(ch.path, { ...ch });
    }
  }
  return [...map.values()];
}

export interface WorkSummary {
  filesChanged: number;
  commands: number;
  calls: number;
  failed: number;
  agents: number;
  byKind: Record<ToolKind, number>;
}

export function summarizeWork(events: readonly TranscriptEvent[]): WorkSummary {
  const tools = allTools(events);
  const t = tallyTools(tools);
  return {
    filesChanged: changedFiles(events).length,
    commands: t.command,
    calls: tools.length,
    failed: tools.filter((x) => x.status === "failed").length,
    agents: events.filter((e) => e.kind === "agent").length,
    byKind: { edit: t.edit, command: t.command, read: t.read, search: t.search, web: t.web, other: t.other },
  };
}

/** 本轮交付:按出现顺序,同一个 ref 只留最后一版 */
export function collectDeliverables(events: readonly TranscriptEvent[]): DeliverableEvent[] {
  const map = new Map<string, DeliverableEvent>();
  for (const e of [...events].sort(bySeq)) {
    if (e.kind !== "deliverable") continue;
    map.delete(e.ref);
    map.set(e.ref, e);
  }
  return [...map.values()];
}

/** Compute 已经停下或出错,记录里还标着「在跑」的调用其实被中断了:显示成失败,原因放在输出第一行(折叠行上露出的就是它),不再转圈。子代理里的同样处理 */
export function interruptRunning(events: readonly TranscriptEvent[], note: string): TranscriptEvent[] {
  const settle = (t: ToolEvent): ToolEvent => (t.status === "running" ? { ...t, status: "failed", output: t.output ? `${note}\n${t.output}` : note } : t);
  return events.map((e) => {
    if (e.kind === "tool") return settle(e);
    if (e.kind === "agent" && e.status === "running") return { ...e, status: "failed", ...(e.trail ? { trail: e.trail.map(settle) } : {}) };
    return e;
  });
}


/** 增量取到的一页并进已有事件:同 id 以新的为准(在跑的调用会更新状态),按 seq 排 */
export function mergeEvents(prev: readonly TranscriptEvent[], incoming: readonly TranscriptEvent[]): TranscriptEvent[] {
  const map = new Map<string, TranscriptEvent>();
  for (const e of prev) map.set(e.id, e);
  for (const e of incoming) map.set(e.id, e);
  return [...map.values()].sort(bySeq);
}


export function sessionElapsedMs(meta: Pick<HarnessSessionMeta, "startedAt" | "endedAt">, now: number): number {
  const start = Date.parse(meta.startedAt);
  const end = meta.endedAt ? Date.parse(meta.endedAt) : now;
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : 0;
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0s";
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const two = (n: number) => String(n).padStart(2, "0");
  if (h > 0) return `${h}h${two(m)}m`;
  if (m > 0) return `${m}m${two(s)}s`;
  return `${s}s`;
}
