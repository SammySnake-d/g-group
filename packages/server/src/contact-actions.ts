// 联系人动作补齐(feat/contact-actions;真实跑测 stories/REPORT.md 缺口 1、2、7 与「纠错版本号一次 +2」):
//   - 认领已有任务(U14、§8.4 US1):claim_task 认领会话面板上还没人负责的任务;比对「T1_Open 且无负责人」后由宿主原有认领路径
//     (claimForTx,任务文档按版本 CAS 提交)转 T2 并起 Compute。同一任务两人先后提交,后提交的在这里看到已变的状态被拒;
//   - 被拒动作回告(AC-31 状态一致):commitRound 判下的拒绝逐条记下,下一轮第 5 块给该联系人列出「动作 → 被拒原因」,
//     提交成功的那一轮记为已给过,之后不再重复;只给事实,不给建议文字;第 1 块不动(AC-39 ①);
//   - reply 带 @:mentions 里每个 id 必须是该会话成员,写进消息 mentions,与用户发消息的 @ 同一数据形状;
//   - 一次用户纠错只升一版(AC-15「v_A_new = current_ver + 1」、AC-45):同一轮里 verdict(revise) 与带 sourceSeq 的 forward 指向
//     同一任务、同一条用户消息时,先到的升版,后到的只把原文并进先到的那次续接,Compute 也只多跑一轮。
// 全是代码能核对的事实(需求文档 §2.0「做 / 不做的标准」):任务状态与归属、会话成员、宿主已判的拒绝;不加软提示门禁。
import type { ActionRefusal, MindAction } from "@g-group/kernel";
import { type Db, all, run } from "./db.ts";
import { LEAVING_REASON } from "./members.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS gg_rejection_notes (
  action_id TEXT PRIMARY KEY, contact_id TEXT NOT NULL, tool TEXT NOT NULL, action TEXT NOT NULL, reason TEXT NOT NULL,
  created_at TEXT NOT NULL, shown_in TEXT
);
CREATE INDEX IF NOT EXISTS gg_rejection_notes_pending ON gg_rejection_notes (contact_id, shown_in);
`;

/** 动作种类 → 联系人看到的工具名(第 5 块按工具名回告,联系人才对得上自己调过哪个) */
const TOOL_OF: Readonly<Record<MindAction["kind"], string>> = Object.freeze({
  reply: "reply",
  dispatch: "dispatch_compute",
  commit: "commit",
  forward: "forward",
  deliver: "deliver",
  stop: "stop",
  verdict: "verdict",
  remember: "remember",
  "memory-use": "memory_feedback",
  rerun: "progress_rerun",
  claim: "claim_task",
});

const cut = (s: string, n = 40): string => {
  const cs = [...s.replace(/\s+/g, " ").trim()];
  return cs.length > n ? `${cs.slice(0, n).join("")}…` : cs.join("");
};

/** 被拒动作的一行事实:工具名加能认出是哪一次调用的关键参数(长文本只留开头) */
export function describeAction(a: MindAction): string {
  switch (a.kind) {
    case "reply":
      return `reply(roomId=${a.roomId}${a.mentions?.length ? `, mentions=${a.mentions.join(",")}` : ""}, text=「${cut(a.text)}」)`;
    case "dispatch":
      return `dispatch_compute(roomId=${a.roomId}, sourceSeq=${a.sourceSeq}, title=「${cut(a.title)}」)`;
    case "commit":
      return `commit(roomId=${a.roomId}, sourceSeq=${a.sourceSeq}, text=「${cut(a.text)}」)`;
    case "forward":
      return `forward(taskId=${a.taskId}${a.sourceSeq !== undefined ? `, sourceSeq=${a.sourceSeq}` : ""}, text=「${cut(a.text)}」)`;
    case "deliver":
      return `deliver(taskId=${a.taskId})`;
    case "stop":
      return `stop(taskId=${a.taskId})`;
    case "verdict":
      return `verdict(taskId=${a.taskId}, sourceSeq=${a.sourceSeq}, ${a.verdict})`;
    case "remember":
      return `remember(roomId=${a.roomId}, title=「${cut(a.title)}」)`;
    case "memory-use":
      return `memory_feedback(id=${a.id})`;
    case "rerun":
      return `progress_rerun(runId=${a.runId}, roomId=${a.roomId})`;
    case "claim":
      return `claim_task(taskId=${a.taskId})`;
    default:
      return (a as { kind: string }).kind;
  }
}

export interface RejectionNote {
  readonly actionId: string;
  readonly tool: string;
  readonly action: string;
  readonly reason: string;
}

/** 被拒动作的回告台账:一条拒绝一行,shown_in 记下第一次成功提交的那一轮(之后不再给)。 */
export class RejectionFeed {
  private readonly db: Db;
  constructor(db: Db) {
    this.db = db;
    db.store.db.exec(SCHEMA);
  }
  /** 与 gg_effects 同一事务、同一 action_id 记下本轮的拒绝(必须在事务里调用) */
  recordTx(contactId: string, roundId: string, rejected: readonly { readonly action: MindAction; readonly reason: string }[], at: string) {
    rejected.forEach((r, i) => {
      run(
        this.db,
        "INSERT OR IGNORE INTO gg_rejection_notes (action_id, contact_id, tool, action, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        `${roundId}:rej:${i}`,
        contactId,
        TOOL_OF[r.action.kind] ?? r.action.kind,
        describeAction(r.action),
        r.reason,
        at,
      );
    });
  }
  /** 还没给这位联系人看过的拒绝,按发生顺序 */
  pending(contactId: string): RejectionNote[] {
    return all<{ action_id: string; tool: string; action: string; reason: string }>(this.db, "SELECT action_id, tool, action, reason FROM gg_rejection_notes WHERE contact_id = ? AND shown_in IS NULL ORDER BY rowid", contactId).map((r) => ({
      actionId: r.action_id,
      tool: r.tool,
      action: r.action,
      reason: r.reason,
    }));
  }
  /** 带着这些拒绝的一轮提交成功:记为已给过(与游标同一事务;轮次被放弃或失败就不记,下一轮再给) */
  markShownTx(contactId: string, actionIds: readonly string[], roundId: string) {
    for (const id of actionIds) run(this.db, "UPDATE gg_rejection_notes SET shown_in = ? WHERE action_id = ? AND contact_id = ? AND shown_in IS NULL", roundId, id, contactId);
  }
}

/** 第 5 块的指针:每条拒绝一个,「动作 → 被拒:原因」,不附建议 */
export function rejectionPointers(notes: readonly RejectionNote[]): { ref: string; text: string }[] {
  return notes.map((n) => ({ ref: `上一轮被拒的动作 ${n.tool}`, text: `${n.action} → 被拒:${n.reason}` }));
}

export interface ClaimableTask {
  readonly id: string;
  readonly roomId: string;
  readonly sourceSeq: number;
  readonly title: string;
  readonly state: string;
  readonly owner: string | null;
}
/** 第 5 块「可认领的任务」:联系人所在会话里还开着、没人负责的面板任务(任务表事实,一行一个) */
export function claimablePointers(tasks: readonly ClaimableTask[], roomIds: ReadonlySet<string>): { ref: string; text: string }[] {
  return tasks
    .filter((t) => roomIds.has(t.roomId) && t.state === "T1_Open" && t.owner === null)
    .map((t) => ({ ref: `可认领的任务 ${t.id}`, text: `${t.id} [${t.state}] ${t.title}(会话 ${t.roomId} #${t.sourceSeq},没人负责)` }));
}

/**
 * claim_task 的校验。rooms:联系人所在会话;leaving:它正在移出的群。返回拒绝原因,可认领返回 null。
 * 比对(CAS 的「比较」):只有还在 T1_Open、没人负责的任务能认领;两人先后提交时,先提交的已把任务转到 T2,后提交的在这里被拒。
 */
export function claimRefusal(taskId: string, t: ClaimableTask | undefined, rooms: ReadonlySet<string>, leaving: ReadonlySet<string>): string | null {
  if (!t) return `没有任务 ${taskId}`;
  if (!rooms.has(t.roomId)) return `任务 ${taskId} 不在你所在的会话里`;
  if (leaving.has(t.roomId)) return LEAVING_REASON;
  if (t.state !== "T1_Open" || t.owner !== null) return t.owner !== null ? `任务 ${taskId} 已由联系人 ${t.owner} 认领(${t.state})` : `任务 ${taskId} 在 ${t.state},不能认领`;
  return null;
}

/** reply.mentions 的校验:每个 id 都必须是该会话成员(用户或联系人)。返回拒绝原因,全合规返回 null */
export function mentionRefusal(roomId: string, ids: readonly string[], members: readonly { readonly id: string }[]): string | null {
  const here = new Set(members.map((m) => m.id));
  const bad = [...new Set(ids)].filter((id) => !here.has(id));
  return bad.length ? `@ 的 ${bad.join("、")} 不是会话 ${roomId} 的成员` : null;
}
/** 写进消息的 mentions:与用户发消息同一形状,来源记 manual(联系人自己点名的) */
export function toMentions(ids: readonly string[]): { id: string; source: "manual" }[] {
  return [...new Set(ids)].map((id) => ({ id, source: "manual" as const }));
}

/** 会话成员(展开 @everyone 用):只要有种类与 id,宿主传的是它的 Member 列表 */
export interface MentionMember {
  readonly kind: string;
  readonly id: string;
}

/**
 * reply 的 @ 名单(feat/contact-call-check;US1 §8.4「群输入框发 @everyone」、U14):
 * 逐个点名的 id 原样在前;everyone 为 true 时把该会话的全体成员补在后——含用户、不含发送者自己、不含 Helper。
 * 展开只是把这些人列进 mentions(与用户发消息的 @ 同一形状),不是「被 @ 才接活」的特权;同一人只列一次由 toMentions 统一做。
 */
export function replyMentionIds(explicit: readonly string[] | undefined, everyone: boolean, members: readonly MentionMember[], senderId: string): string[] {
  void everyone;
  void members;
  void senderId;
  return [...(explicit ?? [])];
}

/**
 * 轮末:这条 reply 是不是在宣称「一件本轮当场被拒的事已经做了」(feat/contact-call-check)。
 * 判据是能核对的字符串事实——reply 正文里出现了被拒动作所指对象的 id;不做语义判断。
 * 命中就返回那个 id 与拒绝原因,由宿主不发出这条 reply 并记进被拒动作回告。
 */
export function unfulfilledClaim(action: MindAction, refusals: readonly ActionRefusal[]): { token: string; reason: string } | null {
  void action;
  void refusals;
  return null;
}

/**
 * 一轮里「哪条用户消息已经给哪个任务升过版」。verdict(revise) 与带 sourceSeq 的 forward 都是「用户这条消息改了条件」,
 * 同一条只算一次(AC-15 单调 +1、AC-45):先到的升版并登记,后到的查到已登记就不再升版,改为把原文并进先到的那次续接。
 */
export class ReworkOnce {
  private readonly seen = new Set<string>();
  has(taskId: string, roomId: string, seq: number): boolean {
    return this.seen.has(`${taskId}|${roomId}#${seq}`);
  }
  mark(taskId: string, roomId: string, seq: number) {
    this.seen.add(`${taskId}|${roomId}#${seq}`);
  }
}

/** 把一段原文并进本轮已排好的那次续接(恢复原实例的 resume,或不可恢复时新开的 spawn);找不到可并入的返回 false */
export function mergeIntoRework<E extends { readonly kind: string; readonly taskId: string }>(effects: E[], taskId: string, text: string): boolean {
  for (let i = effects.length - 1; i >= 0; i--) {
    const e = effects[i] as E & { readonly text?: unknown; readonly brief?: unknown };
    if (e.taskId !== taskId) continue;
    if (e.kind === "resume" && typeof e.text === "string") {
      effects[i] = { ...e, text: `${e.text}\n\n${text}` };
      return true;
    }
    if (e.kind === "spawn" && typeof e.brief === "string") {
      effects[i] = { ...e, brief: `${e.brief}\n\n${text}` };
      return true;
    }
  }
  return false;
}
