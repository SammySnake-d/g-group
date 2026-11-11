// 渲染进程看到的实体视图。字段名对齐需求文档 v3.19 的概念:联系人、私聊/群聊、只追加消息(回复/多条引用)、
// 任务四台状态机里的任务状态、Compute 进度四类语义事件、承诺账本、插件三类、定时(cron + 时区)与 slash 命令。
// 这是「视图」不是领域对象:主进程从领域状态投影出来,渲染进程只读;所有修改都走 api.ts 的方法。
import { arr, bool, id, int, isoTime, json, lit, nullable, obj, oneOf, opt, seq, str, tagged, type Infer } from "./schema.ts";

// ---------- 联系人 ----------
export const HARNESSES = ["claude-code", "codex"] as const;
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
/** Compute 模型三态(AC-32):继承全局 / 跟随说话模型 / 单独指定。 */
export const ModelSlot = obj({
  mode: oneOf(["inherit", "follow-speaking", "explicit"] as const),
  model: opt(str({ max: 200 })),
  effort: opt(oneOf(EFFORTS)),
});
/** 一个槽位的生效值与完整解析链(AC-32 规则 5):界面原样显示 chain,例如「compute 跟随说话模型 → 说话模型 x」。 */
export const MODEL_SUPPORT = ["supported", "unsupported", "undeclared"] as const;
export const ResolvedModelView = obj({
  harness: str({ max: 64 }),
  model: str({ max: 200 }),
  effort: str({ max: 32 }),
  vendor: str({ max: 64 }),
  modelSource: oneOf(["task", "explicit", "follow-speaking", "global"] as const),
  effortSource: oneOf(["task", "compute-slot", "global"] as const),
  chain: arr(str({ max: 300 }), { max: 10 }),
});
export type ResolvedModelView = Infer<typeof ResolvedModelView>;
/** 不兼容时的两条修复路径:单独指定一个兼容的具体模型 / 更换支持该模型的 Harness。candidates 来自能力声明。 */
export const ModelFixView = obj({ kind: oneOf(["explicit-compatible-model", "change-harness"] as const), candidates: arr(str({ max: 200 }), { max: 200 }) });
/** 保存前预检 / 批量替换预览里的一位联系人(AC-32 ②、规则 6)。 */
export const AffectedContactView = obj({
  contactId: id(),
  name: str({ max: 80 }),
  /** explicit-reference:这位联系人的配置里直接写了被改的值;downstream:跟着上游(全局默认 / 说话模型)变 */
  involvement: oneOf(["explicit-reference", "downstream"] as const),
  changed: arr(oneOf(["speaking-model", "harness", "compute-model", "compute-effort"] as const), { max: 4 }),
  speakingBefore: str({ max: 200 }),
  speakingAfter: str({ max: 200 }),
  before: ResolvedModelView,
  after: ResolvedModelView,
  support: oneOf(MODEL_SUPPORT),
  /** 改完后这位联系人的 Compute 启动会被拦。 */
  conflict: bool(),
  fixes: arr(ModelFixView, { max: 2 }),
});
export const ModelChangePreview = obj({
  defaultsChanged: arr(oneOf(["harness", "speakingModel", "computeModel", "effort"] as const), { max: 4 }),
  affected: arr(AffectedContactView, { max: 10000 }),
  conflicts: int({ min: 0 }),
});
export type ModelChangePreview = Infer<typeof ModelChangePreview>;
/** 任务的不可变启动快照与只追加尝试账本(AC-32 ④、AC-51 ⑥)。 */
export const ModelSnapshotView = obj({ harness: str({ max: 64 }), model: str({ max: 200 }), effort: str({ max: 32 }), vendor: str({ max: 64 }) });
export const ModelAttemptView = obj({
  seq: int({ min: 1 }),
  computeId: str({ max: 200 }),
  harness: str({ max: 64 }),
  model: str({ max: 200 }),
  effort: str({ max: 32 }),
  vendor: str({ max: 64 }),
  reason: oneOf(["start", "turn", "retry", "switch-retry", "observed"] as const),
  at: isoTime(),
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
  /** 个人 Compute 槽位数(AC-23,D10 两级配额的个人档):同时最多几个 Compute;null/没有为宿主默认。 */
  computeSlots: opt(nullable(int({ min: 1, max: 64 }))),
  activity: oneOf(CONTACT_ACTIVITY),
  createdAt: isoTime(),
  /** Compute 的生效值、完整解析链与能力声明里的支持性(可选,旧客户端忽略)。 */
  computeResolved: opt(obj({ resolved: ResolvedModelView, support: oneOf(MODEL_SUPPORT) })),
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
  /** 输入框里有未发送草稿时的「[草稿] …」提示(AC-24);存过草稿后清空为 null,从没存过时不出现。 */
  draftPreview: opt(nullable(str({ max: 500 }))),
  updatedAt: isoTime(),
  /** 当前有效群公告条数(AC-55);0 = 无公告空态。私聊恒为 0。 */
  announcementCount: opt(int({ min: 0 })),
  /** 移出中的成员(AC-49/D05):仍在 members 里,但这个群的新消息不再送达、发言与接新活被拒,等在途任务真实停止确认后才移除。 */
  leavingMembers: opt(arr(MemberRef)),
  /** 群临时 Compute 槽位数(AC-23,只给本群任务借用,不跨群);私聊没有这个字段。 */
  tempComputeSlots: opt(int({ min: 0, max: 64 })),
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
/** 交付带回的工件快照(AC-04):按内容 sha256 存一份,卡片钉住 hash;点开用 artifacts.get。 */
export const ArtifactRef = obj({
  ref: id(),
  /** Compute 工作目录里的相对路径 */
  name: str({ max: 500 }),
  mime: str({ max: 200 }),
  bytes: int({ min: 0 }),
  sha256: str({ min: 64, max: 64, pattern: /^[0-9a-f]{64}$/ }),
});
export type ArtifactRef = Infer<typeof ArtifactRef>;
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
  /** 交付消息带回的工件快照(AC-04,U45):卡片引用 ref + sha256,点开用 artifacts.get;没有工件的消息不带这个字段。 */
  artifacts: opt(arr(ArtifactRef, { max: 20 })),
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
  /** Compute 启动后实际加载的 skill 与 MCP 服务器(CLI 自报,AC-29);旧记录没有。 */
  loaded: opt(obj({ skills: arr(str({ max: 200 })), mcpServers: arr(str({ max: 200 })) })),
});
/** 代码任务的隔离工作树(R-Worktree,AC-22):W2 在改 → W3 钉住候选提交 → W4 合入中 → W6 已合入;W5 合入冲突或重验失败(目标分支未动)。 */
export const WORKSPACE_STATES = ["W2_Active", "W3_Pinned", "W4_Integrating", "W5_Conflict", "W6_Merged"] as const;
export const WorkspaceView = obj({
  /** 工作树目录;W6 合入后已清理 */
  dir: str({ max: 4096 }),
  branch: str({ max: 300 }),
  targetBranch: str({ max: 300 }),
  /** 拉出工作树时目标分支的 head(H0) */
  baseSha: str({ max: 64 }),
  /** 审查与合入钉住的候选提交 */
  candidateSha: nullable(str({ max: 64 })),
  state: oneOf(WORKSPACE_STATES),
  /** 最近一次合入时看到的目标分支 head */
  targetHead: nullable(str({ max: 64 })),
  /** 目标分支被推进后,基于哪个 head 合并并重跑了验证;快进合入为 null */
  verifiedOn: nullable(str({ max: 64 })),
  mergedSha: nullable(str({ max: 64 })),
  conflict: nullable(obj({ kind: oneOf(["merge", "verify"] as const), detail: str({ max: 5000 }) })),
});
export type WorkspaceView = Infer<typeof WorkspaceView>;
export const FOLLOW_UP_STATES = ["Received", "Applied", "Rebound"] as const;
export const AUTHORIZATION_STATES = ["pending", "granted", "denied", "expired"] as const;
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
  /**
   * 跨厂商独立审查记录(AC-26),按发起顺序;没有审查过为空或不给。model/vendor 是实际起审查 Compute 用的模型与它的研发厂商。
   * status:running 审查中 / approved 通过 / rejected 打回 / failed 没做成(Compute 失败或结论认不出)/ stopped 任务取消时停掉 / interrupted 宿主重启时已不在。
   */
  reviews: opt(
    arr(
      obj({
        round: int({ min: 1 }),
        reviewerContactId: id(),
        model: str({ max: 200 }),
        vendor: str({ max: 64 }),
        status: oneOf(["running", "approved", "rejected", "failed", "stopped", "interrupted"] as const),
        notes: str({ max: 20000 }),
        startedAt: isoTime(),
        endedAt: nullable(isoTime()),
      }),
      { max: 50 },
    ),
  ),
  computeRuns: arr(ComputeRunView),
  /** 最近若干条进度,完整历史用 tasks.progress 分页取。 */
  recentProgress: arr(ComputeProgress, { max: 20 }),
  /** 任务首次启动时的不可变模型快照;没启动过为 null(可选,旧客户端忽略)。 */
  modelSnapshot: opt(nullable(ModelSnapshotView)),
  /** 只追加的尝试账本:每次启动、每一轮输入、换模型重试各一条。 */
  modelAttempts: opt(arr(ModelAttemptView, { max: 10000 })),
  /** 由账本派生的累积生产厂商集合(跨厂商审查门禁按它判)。 */
  producerVendors: opt(arr(str({ max: 64 }), { max: 50 })),
  artifacts: arr(
    obj({
      ref: id(),
      name: str({ max: 500 }),
      kind: oneOf(["file", "diff", "link", "text"] as const),
      /** file 工件的内容 hash、大小与类型(AC-04),与 artifacts.get 读出的一致 */
      sha256: opt(str({ min: 64, max: 64, pattern: /^[0-9a-f]{64}$/ })),
      bytes: opt(int({ min: 0 })),
      mime: opt(str({ max: 200 })),
    }),
  ),
  /** 代码任务才有(宿主配了代码仓);普通任务不带这个字段。 */
  workspace: opt(WorkspaceView),
  /** 在等什么(AC-23):排队等 Compute 槽位的原因,或「停止未确认」;没有在等为 null。 */
  waitingFor: opt(nullable(str({ max: 500 }))),
  createdAt: isoTime(),
  updatedAt: isoTime(),
  /** 用户手动新建任务时填的描述,原样保留(AC-47);联系人派活建的任务没有这一项。 */
  description: opt(str({ max: 20000 })),
  /**
   * 权威任务文档的版本号(AC-02):群聊主窗口与「从群聊私信」侧边栏读的是同一份文档,同一时刻版本相同;
   * 每次任务文档落盘 +1,task.updated 事件带同一个值。比较新旧以它为准,不按到达顺序。
   */
  stateVer: opt(int({ min: 1 })),
  /** 关联版本:改挂补充(tasks.rebindFollowUp)要带上当前值;任务还没有挂过补充时省略。 */
  bindingVersion: opt(int({ min: 0 })),
  /**
   * 挂在这个任务上的补充消息(AC-15/16/45):Received = 已送达负责人;Applied = 已落实,appliedIn 指向含它的产物、appliedVersion 是产物版本;
   * Rebound = 已改挂到 reboundTo。version 是挂进来时的任务版本。没有挂过补充时省略。
   */
  followUps: opt(arr(obj({
    roomId: id(),
    seq: seq(),
    state: oneOf(FOLLOW_UP_STATES),
    version: int({ min: 0 }),
    appliedIn: nullable(str({ max: 500 })),
    appliedVersion: nullable(int({ min: 0 })),
    reboundTo: nullable(id()),
  }))),
  /**
   * 授权记录(AC-17/19/20):群规「改前先问」时 Compute 要动手前登记一次。用户本人在对话里直接回复「同意」即可放行(按钮可选);
   * 绑定 (qId, constraintVersion);前提变了记 expired(「已过期·未执行」)。没有过授权时省略。
   */
  authorizations: opt(arr(obj({
    qId: id(),
    action: str({ max: 5000 }),
    constraintVersion: int({ min: 0 }),
    state: oneOf(AUTHORIZATION_STATES),
    /** 能授权的人(提出者本人) */
    principalId: id(),
    /** 提问消息 */
    askedSeq: seq(),
    /** 了结它的那条答复消息;未了结或过期为 null */
    decidedSeq: nullable(seq()),
    reason: nullable(str({ max: 2000 })),
  }))),
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

// ---------- 共享文档(AC-21) ----------
/** 群共享文档的权威版本。写入只经 docs.commit:带读到的 version 作 baseVersion,版本变了回 conflict(detail.currentVer),不静默覆盖。 */
export const SharedDocView = obj({
  id: id(),
  /** 所属会话;null 表示不挂会话的个人文档。 */
  roomId: nullable(id()),
  title: str({ min: 1, max: 200 }),
  content: str({ max: 1_000_000 }),
  /** 权威版本号,新建为 1,每次生效的提交 +1。 */
  version: int({ min: 1 }),
  createdAt: isoTime(),
  updatedAt: isoTime(),
  updatedBy: MemberRef,
});
export type SharedDocView = Infer<typeof SharedDocView>;
/** 版本链的一项(不含正文;正文用 docs.get 带 version 取)。 */
export const SharedDocVersionView = obj({
  version: int({ min: 1 }),
  title: str({ min: 1, max: 200 }),
  updatedBy: MemberRef,
  at: isoTime(),
  bytes: int({ min: 0 }),
  /** 产生这一版的请求号(docs.create 为 create:<clientActionId>)。 */
  requestId: id(),
});
export type SharedDocVersionView = Infer<typeof SharedDocVersionView>;

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
  /** 所属会话名(AC-53 联系人视角看各条定时属于哪个群);会话已不存在时省略。 */
  roomTitle: opt(str({ max: 200 })),
  /** 执行定时的联系人名(AC-53 总览看是谁的定时);联系人已不存在时省略。 */
  contactName: opt(str({ max: 80 })),
});
export type ScheduleView = Infer<typeof ScheduleView>;

// ---------- 联系人资料(AC-54)----------
/** 联系人主面板:预设与职责分开给(#1370 是否合并待确认);记忆含工作记忆(状态笔记),长期记忆位置留空待 AC-42。 */
export const ContactProfileView = obj({
  contact: ContactView,
  /** 预设(人设原文),每轮第 1 块使用。 */
  persona: str({ max: 20000 }),
  memory: obj({
    /** 工作记忆:联系人当前状态笔记与版本;还没写过为 null。 */
    stateNote: nullable(obj({ text: str({ max: 100000 }), version: int({ min: 1 }) })),
    /** 长期记忆(AC-42)占位:存储未接入前恒为 null。 */
    longTerm: nullable(json()),
  }),
  duties: obj({
    /** 进行中的承诺(status=active)。 */
    commitments: arr(CommitmentView),
    /** 在途任务(未到 T8/T10/T11)。 */
    tasks: arr(TaskView),
    schedules: arr(ScheduleView),
    /** 所在会话。 */
    rooms: arr(obj({ roomId: id(), kind: oneOf(ROOM_KINDS), title: str({ max: 200 }) })),
  }),
});
export type ContactProfileView = Infer<typeof ContactProfileView>;

// ---------- 会话文件(AC-57 文件列表与窗口联动)----------
export const FileEntry = obj({
  /** 附件为 att-…;任务产出为 task:<id>/result。files.read 用它取内容。 */
  ref: id(),
  name: str({ max: 500 }),
  mime: str({ max: 200 }),
  bytes: int({ min: 0 }),
  source: oneOf(["attachment", "task-result"] as const),
  /** 出现这个文件的消息序号(附件 = 带它的消息;任务产出 = 交付消息,没有交付消息时为派活消息)。 */
  seq: seq(),
  taskId: nullable(id()),
  at: isoTime(),
});
export type FileEntry = Infer<typeof FileEntry>;

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
  /** 清单带 entry、能在隔离进程里执行(plugins.pull / plugins.send 可用)。旧宿主不给。 */
  executable: opt(bool()),
  /** 只有 URL 安装才有:下载内容的 sha256;verified 表示安装时与用户给定的值核对过。 */
  integrity: opt(obj({ sha256: str({ pattern: /^[0-9a-f]{64}$/ }), verified: bool() })),
});
export type PluginView = Infer<typeof PluginView>;

// ---------- 能力库(AC-29)----------
/** 全局能力库:联系人设置页的勾选清单。勾选结果写进 ContactView.computeAssets(contacts.update)。 */
export const CapabilityLibraryView = obj({
  skills: arr(obj({ name: str({ min: 1, max: 64 }), description: str({ max: 2000 }) })),
  mcp: arr(obj({ name: str({ min: 1, max: 64 }) })),
});
export type CapabilityLibraryView = Infer<typeof CapabilityLibraryView>;

/** 插件数据源交来的外部事件(宿主盖过章):来源可追溯,内容永远是不可信数据,只给人看或交给联系人当数据,不当指令。 */
export const ExternalEventView = obj({
  origin: obj({ plugin: id(), source: str({ min: 1, max: 4096 }), nativeId: str({ min: 1, max: 4096 }) }),
  /** 源端版本号:同一 nativeId 每次 create/edit/delete 各一个 */
  sourceVersion: str({ min: 1, max: 4096 }),
  eventType: oneOf(["create", "edit", "delete"] as const),
  author: str({ max: 2000 }),
  content: str({ max: 100000 }),
  /** 源端发生时间 */
  occurredAt: isoTime(),
  /** 宿主收到时间(宿主时钟,不取插件自报) */
  receivedAt: isoTime(),
  attachments: arr(obj({ ref: str({ min: 1, max: 4096 }), name: opt(str({ max: 500 })), mime: opt(str({ max: 200 })) }), { max: 100 }),
  trust: lit("untrusted"),
});
export type ExternalEventView = Infer<typeof ExternalEventView>;

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

// ---------- 搜索(AC-25)----------
/** 一条搜索结果:必带会话与 #seq,点了用 messages.list({ aroundSeq }) 跳回原位置。 */
export const SearchHit = obj({
  roomId: id(),
  roomTitle: str({ max: 200 }),
  seq: seq(),
  /** 命中消息所在话题的根序号;主流消息为 null。 */
  threadRootSeq: nullable(seq()),
  sender: Sender,
  senderName: str({ max: 80 }),
  /** 以关键词为中心截的一段正文(空白压成一个空格),前后被截掉的用「…」表示。 */
  snippet: str({ max: 500 }),
  /** 每个关键词在 snippet 里的位置(UTF-16 下标),给界面高亮用。 */
  highlights: arr(obj({ start: int({ min: 0 }), length: int({ min: 1 }) })),
  /** 正文命中,或只有附件名命中。 */
  matchedIn: oneOf(["text", "attachment"] as const),
  /** 命中的附件文件名;没有附件命中为 null。 */
  attachmentName: nullable(str({ max: 500 })),
  at: isoTime(),
});
export type SearchHit = Infer<typeof SearchHit>;

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

// ---------- Helper(AC-52,U94/D28 第 1 条)----------
/** Helper 的三种入口:全局(⌘K,初始不读任何聊天)、某聊天的侧栏(读当前聊天,对话不上公屏)、聊天里 @Helper(回复作为消息出现在这个聊天)。 */
export const HelperEntry = tagged("kind", {
  global: obj({ kind: lit("global") }),
  sidebar: obj({ kind: lit("sidebar"), roomId: id() }),
  mention: obj({ kind: lit("mention"), roomId: id(), seq: seq() }),
} as const);
export type HelperEntry = Infer<typeof HelperEntry>;
/** 回复出现在哪、会不会成为会话消息、读的是哪个聊天(domain routeHelper 的结果)。 */
export const HelperRoute = obj({
  replyIn: oneOf(["global-panel", "conversation", "sidebar"] as const),
  becomesMessage: bool(),
  contextRoomId: nullable(id()),
  replyToSeq: nullable(seq()),
});
/** 全局面板 / 侧栏里的一条问答记录;不是会话消息,联系人看不到。 */
export const HelperNote = obj({
  id: id(),
  scope: oneOf(["global", "sidebar"] as const),
  roomId: nullable(id()),
  role: oneOf(["user", "helper"] as const),
  text: str({ max: 100000 }),
  at: isoTime(),
});
export type HelperNote = Infer<typeof HelperNote>;
/** Helper 这一次做过的一个操作:op 是服务方法名(工具名不在清单时是工具名),ok 是否执行成功,summary 一句话结果。 */
export const HelperOpResult = obj({ op: str({ min: 1, max: 200 }), ok: bool(), summary: str({ max: 4000 }) });
export type HelperOpResult = Infer<typeof HelperOpResult>;
/** 这次 Helper 请求带进模型的会话与消息(AC-52 观测点):entry 入口给的当前聊天,read_room 模型点名读的,search 搜索命中的。 */
export const HelperContextItem = obj({ roomId: id(), via: oneOf(["entry", "read_room", "search"] as const), seqs: arr(seq()) });
export type HelperContextItem = Infer<typeof HelperContextItem>;
// ---------- 运行台账(AC-43,需求文档 D26):全景画板和联系人的查询读同一张台账 ----------
/** 单元四层五类:联系人轮次 → Compute 会话 → 会话里的轮次 → 后台任务 / 子代理 */
export const RUN_LAYERS = ["contact-round", "compute-session", "compute-turn", "background", "subagent"] as const;
export const RUN_STATUSES = ["queued", "running", "waiting_user", "done", "failed", "interrupted", "orphaned"] as const;
/** D26 第 8.4 节原因类别(与 @g-group/kernel 的规则表同一份名单) */
export const RUN_REASON_CLASSES = [
  "upstream_unavailable", "rate_limited", "no_response", "stream_dropped", "stalled", "context_overflow", "auth_or_quota",
  "invalid_request", "harness_crashed", "session_lost", "platform_refused", "user_stopped", "unknown",
] as const;
/** 能否自动重试(AC-36),与原因类别分开存 */
export const RUN_RETRY_CLASSES = ["Transient", "Permanent", "MidTurn", "UnknownEffect"] as const;
/** 画板色调:人停的(stopped)与失败(failed)分开 */
export const RUN_TONES = ["queued", "running", "waiting", "done", "failed", "stopped", "orphaned"] as const;
export const RunView = obj({
  id: id(),
  layer: oneOf(RUN_LAYERS),
  parentId: nullable(id()),
  children: arr(id(), { max: 1000 }),
  /** 来源:哪个群或私聊、哪条消息 */
  roomId: id(),
  sourceSeq: nullable(seq()),
  /** 属于谁(联系人) */
  contactId: id(),
  taskId: nullable(id()),
  computeId: nullable(id()),
  /** 上游(模型 / 网关),同一上游同一原因的失败合并成一条群级提示 */
  upstream: nullable(str({ max: 400 })),
  status: oneOf(RUN_STATUSES),
  tone: oneOf(RUN_TONES),
  /** 画板一行:「失败 · 原因 · 用时」「已停止」「没跑完 · 宿主进程退出」「运行中 · 已跑 N 分」 */
  text: str({ max: 2000 }),
  reasonClass: nullable(oneOf(RUN_REASON_CLASSES)),
  /** 原因类别的人话 */
  label: nullable(str({ max: 200 })),
  /** 原因原文(折叠在详情里) */
  raw: nullable(str({ max: 20000 })),
  retryClass: nullable(oneOf(RUN_RETRY_CLASSES)),
  rulesVersion: nullable(str({ max: 50 })),
  /** 孤儿原因等说明 */
  note: nullable(str({ max: 2000 })),
  startedAt: isoTime(),
  endedAt: nullable(isoTime()),
  durationMs: int({ min: 0 }),
  lastProgressAt: isoTime(),
  /** 判卡死用的阈值与来源(按默认 / 按联系人 / 按上游单独设) */
  thresholdMs: nullable(int({ min: 0 })),
  thresholdSource: nullable(oneOf(["default", "contact", "upstream"] as const)),
  judgedAt: nullable(isoTime()),
  /** 在跑时正处于的合法等待(不计时) */
  waiting: nullable(oneOf(["waiting_user", "tool_running", "first_byte", "sleep_grace", "children"] as const)),
  /** 在跑时已计入的无进展时长 */
  idleMs: int({ min: 0 }),
  rerunOf: nullable(id()),
  attempt: int({ min: 0 }),
  updatedAt: isoTime(),
});
export type RunView = Infer<typeof RunView>;
export const RunEventView = obj({ runId: id(), kind: str({ max: 50 }), detail: json(), at: isoTime() });
export type RunEventView = Infer<typeof RunEventView>;
/** 群级提示:同一会话里同一上游同一原因的多条失败合并成一条 */
export const RunHint = obj({ roomId: id(), upstream: str({ max: 400 }), reasonClass: oneOf(RUN_REASON_CLASSES), label: str({ max: 200 }), runIds: arr(id(), { max: 1000 }) });
export type RunHint = Infer<typeof RunHint>;
