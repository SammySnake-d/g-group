// 渲染进程看到的实体视图。字段名对齐需求文档 v3.19 的概念:联系人、私聊/群聊、只追加消息(回复/多条引用)、
// 任务四台状态机里的任务状态、Compute 进度四类语义事件、承诺账本、插件三类、定时(cron + 时区)与 slash 命令。
// 这是「视图」不是领域对象:主进程从领域状态投影出来,渲染进程只读;所有修改都走 api.ts 的方法。
import { arr, bool, id, int, isoTime, json, nullable, obj, oneOf, opt, seq, str, type Infer } from "./schema.ts";

// ---------- 联系人 ----------
export const HARNESSES = ["claude-code", "codex"] as const;
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
/** Compute 模型三态(AC-32):继承全局 / 跟随说话模型 / 单独指定。 */
export const ModelSlot = obj({
  mode: oneOf(["inherit", "follow-speaking", "explicit"] as const),
  model: opt(str({ max: 200 })),
  effort: opt(oneOf(EFFORTS)),
});
/** 联系人当前在做什么,驱动头像旁的「正在回复」等状态。 */
export const CONTACT_ACTIVITY = ["idle", "reading", "thinking", "replying", "running-compute", "blocked", "offline"] as const;
export const ContactView = obj({
  id: id(),
  name: str({ min: 1, max: 80 }),
  avatar: nullable(str({ max: 2048 })),
  bio: str({ max: 2000 }),
  speakingModel: str({ max: 200 }),
  harness: oneOf(HARNESSES),
  computeModel: ModelSlot,
  /** 已勾选的具名有界工具与 Compute 能力(skill/MCP),只读展示;授予走 contacts.update。 */
  tools: arr(str({ max: 200 })),
  computeAssets: arr(obj({ name: str({ max: 200 }), kind: oneOf(["mcp", "skill", "script"] as const) })),
  activity: oneOf(CONTACT_ACTIVITY),
  createdAt: isoTime(),
});
export type ContactView = Infer<typeof ContactView>;

// ---------- 会话(私聊 / 群聊)----------
export const ROOM_KINDS = ["dm", "group"] as const;
export const MemberRef = obj({ kind: oneOf(["user", "contact"] as const), id: id() });
export type MemberRef = Infer<typeof MemberRef>;
export const RoomView = obj({
  id: id(),
  kind: oneOf(ROOM_KINDS),
  title: str({ max: 200 }),
  avatar: nullable(str({ max: 2048 })),
  members: arr(MemberRef),
  /** 群公告 / 群规(宿主机械注入给联系人的生效版本号)。 */
  rules: str({ max: 20000 }),
  rulesVersion: int({ min: 0 }),
  pinned: bool(),
  muted: bool(),
  lastSeq: seq(),
  /** 当前用户的已读位置;unread = lastSeq 之后、非自己发的消息数。 */
  readSeq: seq(),
  unread: int({ min: 0 }),
  /** 有需要用户处理的事(交付待确认、提问、失败卡)时 > 0,会话列表显示红点。 */
  pendingForUser: int({ min: 0 }),
  lastMessagePreview: nullable(str({ max: 500 })),
  updatedAt: isoTime(),
  /** 当前有效群公告条数(AC-55);0 = 无公告空态。私聊恒为 0。 */
  announcementCount: opt(int({ min: 0 })),
  /** 移出中的成员(AC-49/D05):仍在 members 里,但这个群的新消息不再送达、发言与接新活被拒,等在途任务真实停止确认后才移除。 */
  leavingMembers: opt(arr(MemberRef)),
});
export type RoomView = Infer<typeof RoomView>;
/** 群公告(U97/U86):一个群可有多条,当前有效的全部装配进联系人第 1 块「群规快照」位。version 每次改动 +1(CAS 用)。 */
export const ANNOUNCEMENT_ORDERS = ["created-asc", "created-desc"] as const;
export const AnnouncementView = obj({
  id: id(),
  roomId: id(),
  text: str({ min: 1, max: 20000 }),
  version: int({ min: 1 }),
  createdAt: isoTime(),
  updatedAt: isoTime(),
});
export type AnnouncementView = Infer<typeof AnnouncementView>;

// ---------- 消息 ----------
export const SENDER_KINDS = ["user", "contact", "helper", "system"] as const;
export const Sender = obj({ kind: oneOf(SENDER_KINDS), id: id() });
export const Attachment = obj({ ref: id(), name: str({ max: 500 }), mime: str({ max: 200 }), bytes: int({ min: 0 }) });
/** 消息里的结构化卡片:任务状态卡、交付卡、提问卡、失败可重试卡。按钮的点击走 cards.act,以对话消息形式记录。 */
export const CARD_KINDS = ["task-status", "delivery", "question", "failure", "schedule-fired", "plugin-result"] as const;
export const CardAction = obj({ actionId: id(), label: str({ min: 1, max: 40 }), style: oneOf(["primary", "default", "danger"] as const) });
export const Card = obj({
  kind: oneOf(CARD_KINDS),
  cardId: id(),
  taskId: nullable(id()),
  title: str({ max: 200 }),
  body: str({ max: 20000 }),
  /** CardOpen → Claimed → Done;领取过的卡按钮置灰(AC-36 CAS 领取)。 */
  state: oneOf(["open", "claimed", "done", "expired"] as const),
  actions: arr(CardAction, { max: 6 }),
});
export const Reaction = obj({ emoji: str({ min: 1, max: 32 }), by: arr(MemberRef) });
export const SlashInvocation = obj({ name: str({ min: 1, max: 64 }), args: json() });
export const MessageView = obj({
  roomId: id(),
  seq: seq(),
  /** 话题(thread)根消息序号;主流消息为 null。 */
  threadRootSeq: nullable(seq()),
  sender: Sender,
  text: str({ max: 100000 }),
  /** 正文里的 @;auto 为点「回复」自动注入,manual 为用户手打(AC-37 删主回复只移除 auto)。 */
  mentions: arr(obj({ id: id(), source: oneOf(["auto", "manual"] as const) })),
  /** 主回复对象;回复 = @原作者 + 引用。 */
  replyToSeq: nullable(seq()),
  /** 一次连续引用的多条消息,保序去重。 */
  quotedSeqs: arr(seq(), { max: 50 }),
  /** 引用块的展示快照(撤回的显示占位)。 */
  quotes: arr(obj({ seq: seq(), senderName: str({ max: 80 }), excerpt: str({ max: 500 }), state: oneOf(["ok", "retracted", "denied"] as const) })),
  attachments: arr(Attachment),
  card: nullable(Card),
  command: nullable(SlashInvocation),
  reactions: arr(Reaction),
  edited: bool(),
  retracted: bool(),
  /** 发送方客户端生成的动作号,重放时去重(AC-31 action_id)。 */
  clientActionId: nullable(id()),
  at: isoTime(),
  /** 私聊 rewind 撤下的消息为 true(AC-48):记录保留、照常列出(界面可置灰),但不再作为任何联系人的当前上下文。缺省视为 false。 */
  rewound: opt(bool()),
});
export type MessageView = Infer<typeof MessageView>;

/** 已读回执(AC-46):群里名单 = 成员(含联系人)减发送人;接走即已读。 */
export const ReceiptView = obj({
  roomId: id(),
  seq: seq(),
  read: arr(obj({ member: MemberRef, at: isoTime(), mentioned: bool() })),
  unread: arr(obj({ member: MemberRef, mentioned: bool() })),
});
export type ReceiptView = Infer<typeof ReceiptView>;

// ---------- 任务与 Compute ----------
/** 与 @g-group/domain 的 STATES 逐项一致(由服务层测试核对)。 */
export const TASK_STATES = [
  "T1_Open",
  "T2_Claimed",
  "T3_Running",
  "T4b_BlockedOnHuman",
  "T5_InReview",
  "T7_Delivering",
  "T8a_Delivered",
  "T8_Accepted",
  "T9_StopRequested",
  "T10_Cancelled",
  "T11_Failed",
] as const;
export type TaskStateName = (typeof TASK_STATES)[number];
/** Compute 四类语义事件 + 起止(与 @g-group/adapter-cc-compute ComputeEvent.kind 一致)。 */
export const COMPUTE_EVENT_KINDS = ["started", "milestone", "blocked", "completed", "failed", "stopped"] as const;
export const ComputeProgress = obj({
  computeId: id(),
  taskId: id(),
  kind: oneOf(COMPUTE_EVENT_KINDS),
  stage: opt(str({ max: 200 })),
  summary: str({ max: 20000 }),
  at: isoTime(),
});
export type ComputeProgress = Infer<typeof ComputeProgress>;
export const ComputeRunView = obj({
  computeId: id(),
  harness: oneOf(HARNESSES),
  model: str({ max: 200 }),
  placement: oneOf(["local", "byom_daemon", "cloud_sandbox"] as const),
  status: oneOf(["starting", "running", "blocked", "completed", "failed", "stopped"] as const),
  startedAt: isoTime(),
  endedAt: nullable(isoTime()),
});
export const TaskView = obj({
  id: id(),
  title: str({ max: 500 }),
  roomId: id(),
  /** 派活的那条消息。 */
  sourceSeq: seq(),
  requesterId: id(),
  ownerContactId: nullable(id()),
  state: oneOf(TASK_STATES),
  constraintVersion: int({ min: 0 }),
  /** T4b 时联系人在问用户的问题。 */
  pendingQuestion: nullable(obj({ qId: id(), text: str({ max: 5000 }) })),
  reviewGate: oneOf(["none", "compliant", "waived-by-user"] as const),
  computeRuns: arr(ComputeRunView),
  /** 最近若干条进度,完整历史用 tasks.progress 分页取。 */
  recentProgress: arr(ComputeProgress, { max: 20 }),
  artifacts: arr(obj({ ref: id(), name: str({ max: 500 }), kind: oneOf(["file", "diff", "link", "text"] as const) })),
  createdAt: isoTime(),
  updatedAt: isoTime(),
  /** 用户手动新建任务时填的描述,原样保留(AC-47);联系人派活建的任务没有这一项。 */
  description: opt(str({ max: 20000 })),
});
export type TaskView = Infer<typeof TaskView>;

// ---------- 私聊 rewind(AC-48 / U26 / D05)----------
/** 回退会影响到的东西。预览(rooms.rewindPreview)只读算出这份清单;执行(rooms.rewind)按它落盘并如实返回。 */
const RewindFields = {
  roomId: id(),
  /** 回退点:这条及之前的消息保留,之后的撤下。 */
  toSeq: seq(),
  /** 将被撤下(执行结果里为已撤下)的消息;已在更早回退里撤下的不重复列。 */
  messages: arr(obj({ seq: seq(), sender: Sender, excerpt: str({ max: 500 }) })),
  /** 来源消息在回退点之后、将被取消的在途任务。执行结果里的 state 是取消后的真实状态:有 Compute 在跑时为 T9_StopRequested,等 Compute 确认停下才到 T10。 */
  tasks: arr(obj({ taskId: id(), title: str({ max: 500 }), sourceSeq: seq(), state: oneOf(TASK_STATES) })),
  /** 来源消息在回退点之后、将作废的未了结承诺(账本记为 revoked)。 */
  commitments: arr(obj({ commitmentId: id(), contactId: id(), sourceSeq: seq(), taskId: nullable(id()), text: str({ max: 5000 }) })),
  /**
   * 已经发生、回退不会撤销的外部副作用:来源在回退点之后的任务已起过的 Compute(可能已改文件、调外部服务)及其已产出的结果。
   * kind 目前只有 "compute";以后接入外发渠道等再加取值。
   */
  sideEffects: arr(
    obj({
      kind: str({ min: 1, max: 64 }),
      taskId: id(),
      taskTitle: str({ max: 500 }),
      computeId: id(),
      status: oneOf(["starting", "running", "blocked", "completed", "failed", "stopped"] as const),
      result: nullable(str({ max: 20000 })),
      startedAt: isoTime(),
      endedAt: nullable(isoTime()),
    }),
  ),
};
export const RewindPreview = obj(RewindFields);
export type RewindPreview = Infer<typeof RewindPreview>;
export const RewindResult = obj({
  ...RewindFields,
  /** 宿主替用户记进会话的那条回退说明消息(决策是共享上下文;联系人经正常送达收到它并更新状态笔记)。 */
  markerSeq: seq(),
  at: isoTime(),
});
export type RewindResult = Infer<typeof RewindResult>;

// ---------- 承诺账本 ----------
export const CommitmentView = obj({
  id: id(),
  contactId: id(),
  roomId: id(),
  sourceSeq: seq(),
  taskId: nullable(id()),
  text: str({ max: 5000 }),
  status: oneOf(["active", "done", "revoked", "superseded", "blocked"] as const),
  scheduleId: nullable(id()),
  updatedAt: isoTime(),
});
export type CommitmentView = Infer<typeof CommitmentView>;

// ---------- 定时(cron) ----------
/** 定时归联系人(插件不能自带 schedule):联系人在某个会话里按 cron 执行一段指令。 */
export const ScheduleView = obj({
  id: id(),
  contactId: id(),
  roomId: id(),
  title: str({ min: 1, max: 200 }),
  /** 5 段 cron(分 时 日 月 周),服务端校验并给出下次触发时间。 */
  cron: str({ min: 9, max: 200 }),
  /** IANA 时区,如 Asia/Shanghai;DST 由服务端按时区计算。 */
  tz: str({ min: 1, max: 64 }),
  prompt: str({ min: 1, max: 20000 }),
  enabled: bool(),
  /** 允许的触发误差(秒),超过视为错过,按 missedPolicy 处理。 */
  toleranceSec: int({ min: 0, max: 86400 }),
  missedPolicy: oneOf(["skip", "run-once"] as const),
  nextRunAt: nullable(isoTime()),
  lastRun: nullable(obj({ at: isoTime(), status: oneOf(["ok", "failed", "missed", "running"] as const), messageSeq: nullable(seq()) })),
  commitmentId: nullable(id()),
  createdAt: isoTime(),
});
export type ScheduleView = Infer<typeof ScheduleView>;

// ---------- 插件 ----------
export const PLUGIN_KINDS = ["data-source", "outbound-channel", "ui-extension"] as const;
export const PluginPermission = obj({ key: str({ min: 1, max: 100 }), description: str({ max: 500 }) });
export const MarketplaceEntry = obj({
  id: id(),
  name: str({ min: 1, max: 100 }),
  publisher: str({ max: 100 }),
  description: str({ max: 5000 }),
  icon: nullable(str({ max: 2048 })),
  kinds: arr(oneOf(PLUGIN_KINDS)),
  latestVersion: str({ min: 1, max: 50 }),
  /** 安装后会注册的 slash 命令,市场页预览用。 */
  commands: arr(str({ max: 64 })),
  permissions: arr(PluginPermission),
  installed: bool(),
});
export type MarketplaceEntry = Infer<typeof MarketplaceEntry>;
export const PluginView = obj({
  id: id(),
  name: str({ min: 1, max: 100 }),
  version: str({ min: 1, max: 50 }),
  latestVersion: nullable(str({ max: 50 })),
  kinds: arr(oneOf(PLUGIN_KINDS)),
  source: oneOf(["marketplace", "local-path", "url"] as const),
  enabled: bool(),
  status: oneOf(["installing", "ready", "error", "updating", "uninstalling"] as const),
  error: nullable(str({ max: 2000 })),
  permissions: arr(PluginPermission),
  /** 插件自己的配置 JSON Schema 与当前值;渲染进程按 schema 生成表单。 */
  configSchema: nullable(json()),
  config: nullable(json()),
  commands: arr(str({ max: 64 })),
  installedAt: isoTime(),
});
export type PluginView = Infer<typeof PluginView>;

// ---------- Slash 命令 ----------
export const SlashArg = obj({
  name: str({ min: 1, max: 40 }),
  description: str({ max: 200 }),
  kind: oneOf(["text", "number", "contact", "choice", "cron"] as const),
  required: bool(),
  choices: opt(arr(str({ max: 100 }), { max: 50 })),
});
export const SlashCommand = obj({
  /** 不含前导斜杠,小写字母数字与连字符,如 summary、remind。 */
  name: str({ min: 1, max: 32, pattern: /^[a-z0-9][a-z0-9_-]*$/ }),
  description: str({ max: 200 }),
  args: arr(SlashArg, { max: 10 }),
  source: oneOf(["builtin", "plugin", "contact"] as const),
  pluginId: nullable(id()),
  /** 由谁执行:builtin 的宿主命令为 null;插件/联系人能力为目标联系人。 */
  targetContactId: nullable(id()),
});
export type SlashCommand = Infer<typeof SlashCommand>;

// ---------- 设置 ----------
export const SettingsView = obj({
  defaultHarness: oneOf(HARNESSES),
  defaultSpeakingModel: str({ max: 200 }),
  defaultComputeModel: str({ max: 200 }),
  defaultEffort: oneOf(EFFORTS),
  timezone: str({ min: 1, max: 64 }),
  models: arr(obj({ id: str({ min: 1, max: 200 }), label: str({ max: 200 }), vendor: str({ max: 64 }), harnesses: arr(oneOf(HARNESSES)) })),
});
export type SettingsView = Infer<typeof SettingsView>;
