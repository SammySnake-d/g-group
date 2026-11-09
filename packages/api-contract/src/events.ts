// 主进程推给渲染进程的事件流。每条事件带全局递增的 eventSeq:渲染进程断线/刷新后用 sinceEventSeq 续订,
// 服务端补发缺口;缺口太大(已丢弃)时回 resync=true,渲染进程重新 list。
import { CommitmentView, ComputeProgress, CONTACT_ACTIVITY, ContactView, MemberRef, MessageView, PluginView, RoomView, ScheduleView, SharedDocView, SlashCommand, TaskView } from "./entities.ts";
import { DraftView } from "./draft.ts";
import { arr, id, int, isoTime, nullable, obj, oneOf, seq, str, tagged, type Infer, lit } from "./schema.ts";

const ev = <T extends string, S extends Record<string, Parameters<typeof obj>[0][string]>>(type: T, payload: S) =>
  obj({ type: lit(type), eventSeq: seq(), at: isoTime(), ...payload });

export const ServerEvent = tagged("type", {
  "message.appended": ev("message.appended", { message: MessageView }),
  /** 编辑、撤回、表情、卡片状态变化:整条替换。 */
  "message.updated": ev("message.updated", { message: MessageView }),
  "receipt.updated": ev("receipt.updated", { roomId: id(), member: MemberRef, readSeq: seq() }),
  "room.updated": ev("room.updated", { room: RoomView }),
  "room.removed": ev("room.removed", { roomId: id() }),
  /** 某会话的输入框草稿变了(另一个窗口保存、发送回执清理):渲染进程按 draftVer 合并。 */
  "draft.updated": ev("draft.updated", { draft: DraftView }),
  "contact.updated": ev("contact.updated", { contact: ContactView }),
  "contact.removed": ev("contact.removed", { contactId: id() }),
  /** 输入框上方「xx 正在回复…」;roomId 为 null 表示不在任何会话里活动。 */
  "contact.activity": ev("contact.activity", { contactId: id(), roomId: nullable(id()), activity: oneOf(CONTACT_ACTIVITY) }),
  "task.updated": ev("task.updated", { task: TaskView }),
  "compute.progress": ev("compute.progress", { progress: ComputeProgress }),
  "commitment.updated": ev("commitment.updated", { commitment: CommitmentView }),
  /** 共享文档有新的生效版本(重放、冲突不发)。 */
  "doc.updated": ev("doc.updated", { doc: SharedDocView }),
  "schedule.updated": ev("schedule.updated", { schedule: ScheduleView }),
  "schedule.removed": ev("schedule.removed", { scheduleId: id() }),
  "plugin.updated": ev("plugin.updated", { plugin: PluginView }),
  "plugin.removed": ev("plugin.removed", { pluginId: id() }),
  /** 某会话可用 slash 命令集合变了(插件启停、联系人能力变化),渲染进程刷新补全列表。 */
  "commands.changed": ev("commands.changed", { roomId: nullable(id()), commands: nullable(arr(SlashCommand)) }),
  /**
   * 失败轮次的自动重试与失败卡状态(AC-36):retrying 时状态行显示「重连中 attempt/limit」(不出卡);card 表示已出原位失败卡;
   * paused 表示被共享上游熔断暂停(全群只出 1 张群级卡);cleared 表示已恢复或已处理。scope=contact 是联系人一轮,task 是任务的 Compute。
   */
  "retry.updated": ev("retry.updated", {
    scope: oneOf(["contact", "task"] as const),
    contactId: id(),
    taskId: nullable(id()),
    roomId: nullable(id()),
    state: oneOf(["retrying", "card", "paused", "cleared"] as const),
    attempt: int({ min: 0 }),
    limit: int({ min: 0 }),
    label: str({ max: 200 }),
  }),
  /** 订阅续接失败(缺口已丢弃):渲染进程需全量重拉。 */
  "stream.resync": ev("stream.resync", { reason: str({ max: 500 }) }),
} as const);
export type ServerEvent = Infer<typeof ServerEvent>;
export type ServerEventType = ServerEvent["type"];
export type EventOf<T extends ServerEventType> = Extract<ServerEvent, { type: T }>;
