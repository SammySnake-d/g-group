// 渲染进程经 preload 调用的方法表。每个方法 = 参数 schema + 结果 schema;主进程收到调用先校验参数,
// 回包前校验结果,渲染进程收到回包可再校验一次(开发模式)。方法名「域.动作」,新增只加不改。
import {
  ANNOUNCEMENT_ORDERS,
  AnnouncementView,
  CommitmentView,
  ComputeProgress,
  ContactView,
  EFFORTS,
  HARNESSES,
  MarketplaceEntry,
  MemberRef,
  MessageView,
  ModelSlot,
  PluginView,
  ReceiptView,
  RewindPreview,
  RewindResult,
  RoomView,
  ScheduleView,
  SettingsView,
  SlashCommand,
  SlashInvocation,
  TASK_STATES,
  TaskView,
} from "./entities.ts";
import { arr, bool, id, int, isoTime, json, lit, nullable, obj, oneOf, opt, type Schema, seq, str, tagged } from "./schema.ts";

/** 合同版本:破坏性改动加主版本;渲染进程启动时用 session.hello 核对。 */
export const API_VERSION = "0.1.0";

const Empty = obj({});
const Ok = obj({ ok: lit(true) });
const Page = { limit: opt(int({ min: 1, max: 500 })) };

const method = <P, R>(params: Schema<P>, result: Schema<R>) => ({ params, result });

export const METHODS = {
  // 会话握手:核对合同版本,拿当前事件游标(订阅从这里接)。
  "session.hello": method(obj({ clientApiVersion: str({ max: 20 }) }), obj({ apiVersion: str(), serverTime: isoTime(), eventSeq: seq(), userId: id() })),

  // ---- 联系人 ----
  "contacts.list": method(Empty, obj({ contacts: arr(ContactView) })),
  "contacts.get": method(obj({ contactId: id() }), ContactView),
  "contacts.create": method(
    obj({ clientActionId: id(), name: str({ min: 1, max: 80 }), bio: opt(str({ max: 2000 })), speakingModel: opt(str({ max: 200 })), harness: opt(oneOf(HARNESSES)), computeModel: opt(ModelSlot) }),
    ContactView,
  ),
  "contacts.update": method(
    obj({
      contactId: id(),
      name: opt(str({ min: 1, max: 80 })),
      bio: opt(str({ max: 2000 })),
      avatar: opt(nullable(str({ max: 2048 }))),
      speakingModel: opt(str({ max: 200 })),
      harness: opt(oneOf(HARNESSES)),
      computeModel: opt(ModelSlot),
      tools: opt(arr(str({ max: 200 }))),
      computeAssets: opt(arr(obj({ name: str({ max: 200 }), kind: oneOf(["mcp", "skill", "script"] as const) }))),
    }),
    ContactView,
  ),
  "contacts.remove": method(obj({ contactId: id() }), Ok),

  // ---- 会话 ----
  "rooms.list": method(Empty, obj({ rooms: arr(RoomView) })),
  "rooms.get": method(obj({ roomId: id() }), RoomView),
  /** 打开与某联系人的私聊;已存在则返回原会话。 */
  "rooms.openDm": method(obj({ contactId: id() }), RoomView),
  "rooms.createGroup": method(obj({ clientActionId: id(), title: str({ min: 1, max: 200 }), members: arr(MemberRef, { max: 100 }) }), RoomView),
  "rooms.update": method(obj({ roomId: id(), title: opt(str({ min: 1, max: 200 })), pinned: opt(bool()), muted: opt(bool()), rules: opt(str({ max: 20000 })), expectedRulesVersion: opt(int({ min: 0 })) }), RoomView),
  "rooms.addMembers": method(obj({ roomId: id(), members: arr(MemberRef, { max: 100 }) }), RoomView),
  /**
   * 移出成员。联系人在这个群有在途任务(T8/T10/T11 以外)时默认 conflict,detail.tasks 列出 {taskId,title,state};
   * stopTasks=true 时先进「移出中」(RoomView.leavingMembers),在途任务 Cancel → 停 Compute,真实停止确认后才移除并推 room.updated。
   */
  "rooms.removeMember": method(obj({ roomId: id(), member: MemberRef, stopTasks: opt(bool()) }), RoomView),
  /** 用户自己的已读位置,只影响用户视图(AC-46)。 */
  "rooms.markRead": method(obj({ roomId: id(), seq: seq() }), Ok),
  /** 私聊 rewind 预览(AC-48):只读,不改任何状态;用户看完不确认即取消。群聊 forbidden;回退点不是本会话的消息 invalid_params。 */
  "rooms.rewindPreview": method(obj({ roomId: id(), toSeq: seq() }), RewindPreview),
  /** 私聊 rewind 执行:回退点之后的消息撤下、来源于它们的在途任务取消、未了结承诺作废;已发生的外部副作用如实列出,不撤销。clientActionId 幂等。 */
  "rooms.rewind": method(obj({ roomId: id(), toSeq: seq(), clientActionId: id() }), RewindResult),

  // ---- 群公告(AC-55,U97/U86):一个群可有多条;改动推 room.updated;联系人下一轮装配读当前全部有效公告 ----
  /** 当前有效公告;order 缺省按创建先后(created-asc)。私聊返回空数组。 */
  "announcements.list": method(obj({ roomId: id(), order: opt(oneOf(ANNOUNCEMENT_ORDERS)) }), obj({ announcements: arr(AnnouncementView) })),
  /** 新增一条,不覆盖已有的;同一 clientActionId 重发返回原条目。私聊 forbidden。 */
  "announcements.add": method(obj({ roomId: id(), clientActionId: id(), text: str({ min: 1, max: 20000 }) }), AnnouncementView),
  /** 改正文;expectedVersion 不符回 conflict(detail.currentVer)。正文没变不升版本。 */
  "announcements.update": method(obj({ announcementId: id(), text: str({ min: 1, max: 20000 }), expectedVersion: opt(int({ min: 1 })) }), AnnouncementView),
  /** 撤下一条(保留记录,不再显示和装配);expectedVersion 不符回 conflict。 */
  "announcements.remove": method(obj({ announcementId: id(), expectedVersion: opt(int({ min: 1 })) }), Ok),

  // ---- 消息 ----
  "messages.list": method(
    obj({ roomId: id(), threadRootSeq: opt(nullable(seq())), beforeSeq: opt(seq()), afterSeq: opt(seq()), ...Page }),
    obj({ messages: arr(MessageView), hasMore: bool() }),
  ),
  /** 发送。clientActionId 由渲染进程生成,同一号重发返回同一条消息(不重复入库)。 */
  "messages.send": method(
    obj({
      roomId: id(),
      clientActionId: id(),
      text: str({ max: 100000 }),
      threadRootSeq: opt(nullable(seq())),
      replyToSeq: opt(nullable(seq())),
      quotedSeqs: opt(arr(seq(), { max: 50 })),
      mentions: opt(arr(obj({ id: id(), source: oneOf(["auto", "manual"] as const) }), { max: 100 })),
      attachments: opt(arr(id(), { max: 20 })),
      /** 在输入框里选了 slash 命令时带上;text 仍是用户看到的原文(如 "/summary 今天")。 */
      command: opt(SlashInvocation),
    }),
    MessageView,
  ),
  "messages.edit": method(obj({ roomId: id(), seq: seq(), text: str({ max: 100000 }) }), MessageView),
  "messages.retract": method(obj({ roomId: id(), seq: seq() }), MessageView),
  "messages.react": method(obj({ roomId: id(), seq: seq(), emoji: str({ min: 1, max: 32 }), on: bool() }), MessageView),
  "messages.receipts": method(obj({ roomId: id(), seq: seq() }), ReceiptView),
  /** 上传附件(渲染进程先把文件交给 preload 拿到本地路径)。 */
  "attachments.add": method(obj({ path: str({ min: 1, max: 4096 }) }), obj({ ref: id(), name: str(), mime: str(), bytes: int({ min: 0 }) })),

  // ---- 卡片按钮(交付确认、提问回答、失败重试…),以对话消息形式记录 ----
  "cards.act": method(obj({ roomId: id(), seq: seq(), cardId: id(), actionId: id(), clientActionId: id(), text: opt(str({ max: 20000 })) }), MessageView),

  // ---- 任务 ----
  "tasks.list": method(
    obj({ roomId: opt(id()), contactId: opt(id()), states: opt(arr(oneOf(TASK_STATES))), ...Page }),
    obj({ tasks: arr(TaskView) }),
  ),
  "tasks.get": method(obj({ taskId: id() }), TaskView),
  "tasks.progress": method(obj({ taskId: id(), afterAt: opt(isoTime()), ...Page }), obj({ progress: arr(ComputeProgress) })),
  /** 普通回复也能确认/退回(AC-28);这两个是同一语义的显式入口。 */
  "tasks.accept": method(obj({ taskId: id(), clientActionId: id() }), TaskView),
  "tasks.reject": method(obj({ taskId: id(), clientActionId: id(), feedback: str({ min: 1, max: 20000 }) }), TaskView),
  "tasks.answer": method(obj({ taskId: id(), qId: id(), clientActionId: id(), answer: str({ min: 1, max: 20000 }) }), TaskView),
  "tasks.cancel": method(obj({ taskId: id(), clientActionId: id() }), TaskView),
  /**
   * 手动新建任务(AC-47 候选底座 / U14;也是 AC-52 Helper 把 CSV 转成本群任务的后端,逐行调用)。
   * 以用户的一条对话消息记进会话(带任务卡,可取消);指定负责人时它必须是本会话的联系人成员,自动 @ 它、由它认领并起 Compute
   * (brief = 标题 + 描述);不指定则停在 T1_Open,之后用 tasks.assign。表单字段、默认负责人未定,description/ownerContactId 都可选。clientActionId 幂等。
   */
  "tasks.create": method(
    obj({ clientActionId: id(), roomId: id(), title: str({ min: 1, max: 500 }), description: opt(str({ max: 20000 })), ownerContactId: opt(id()) }),
    TaskView,
  ),
  /** 给还没人负责(T1_Open)的任务指定负责人:以用户一条对话消息记录并 @ 它,由它认领并起 Compute。已有负责人 conflict;不是本会话联系人 invalid_params。clientActionId 幂等。 */
  "tasks.assign": method(obj({ taskId: id(), contactId: id(), clientActionId: id() }), TaskView),

  // ---- 承诺账本 ----
  "commitments.list": method(obj({ contactId: opt(id()), roomId: opt(id()), status: opt(oneOf(["active", "done", "revoked", "superseded", "blocked"] as const)) }), obj({ commitments: arr(CommitmentView) })),
  "commitments.revoke": method(obj({ commitmentId: id(), clientActionId: id() }), CommitmentView),

  // ---- 定时(cron) ----
  "schedules.list": method(obj({ contactId: opt(id()), roomId: opt(id()) }), obj({ schedules: arr(ScheduleView) })),
  /** 校验 cron + 时区并给出接下来 N 次触发时间;表单实时预览用,不落盘。 */
  "schedules.preview": method(
    obj({ cron: str({ min: 1, max: 200 }), tz: str({ min: 1, max: 64 }), count: opt(int({ min: 1, max: 20 })) }),
    /** valid=false 时 error 给出人话原因;valid=true 时 description 是「每天 08:00(Asia/Shanghai)」这类说明。 */
    obj({ valid: bool(), description: nullable(str({ max: 500 })), next: arr(isoTime(), { max: 20 }), error: nullable(str({ max: 500 })) }),
  ),
  "schedules.create": method(
    obj({
      clientActionId: id(),
      contactId: id(),
      roomId: id(),
      title: str({ min: 1, max: 200 }),
      cron: str({ min: 1, max: 200 }),
      tz: str({ min: 1, max: 64 }),
      prompt: str({ min: 1, max: 20000 }),
      enabled: opt(bool()),
      toleranceSec: opt(int({ min: 0, max: 86400 })),
      missedPolicy: opt(oneOf(["skip", "run-once"] as const)),
    }),
    ScheduleView,
  ),
  "schedules.update": method(
    obj({
      scheduleId: id(),
      title: opt(str({ min: 1, max: 200 })),
      cron: opt(str({ min: 1, max: 200 })),
      tz: opt(str({ min: 1, max: 64 })),
      prompt: opt(str({ min: 1, max: 20000 })),
      enabled: opt(bool()),
      toleranceSec: opt(int({ min: 0, max: 86400 })),
      missedPolicy: opt(oneOf(["skip", "run-once"] as const)),
    }),
    ScheduleView,
  ),
  "schedules.remove": method(obj({ scheduleId: id() }), Ok),
  "schedules.runNow": method(obj({ scheduleId: id(), clientActionId: id() }), ScheduleView),
  "schedules.history": method(obj({ scheduleId: id(), ...Page }), obj({ runs: arr(obj({ at: isoTime(), status: oneOf(["ok", "failed", "missed", "running"] as const), messageSeq: nullable(seq()), error: nullable(str()) })) })),

  // ---- 插件 ----
  "plugins.marketplace": method(obj({ query: opt(str({ max: 200 })), kind: opt(oneOf(["data-source", "outbound-channel", "ui-extension"] as const)) }), obj({ entries: arr(MarketplaceEntry) })),
  "plugins.list": method(Empty, obj({ plugins: arr(PluginView) })),
  "plugins.get": method(obj({ pluginId: id() }), PluginView),
  /** 安装:市场条目 / 本地目录 / URL。返回时状态可能仍是 installing,结果走 plugin.updated 事件。 */
  "plugins.install": method(
    obj({
      clientActionId: id(),
      source: tagged("kind", {
        marketplace: obj({ kind: lit("marketplace"), id: id(), version: opt(str({ max: 50 })) }),
        "local-path": obj({ kind: lit("local-path"), path: str({ min: 1, max: 4096 }) }),
        url: obj({ kind: lit("url"), url: str({ min: 1, max: 4096, pattern: /^https:\/\// }) }),
      } as const),
      /** 用户在安装确认框里勾选同意的权限键;少于插件声明的权限时安装被拒。 */
      grantedPermissions: arr(str({ min: 1, max: 100 })),
    }),
    PluginView,
  ),
  "plugins.setEnabled": method(obj({ pluginId: id(), enabled: bool() }), PluginView),
  "plugins.configure": method(obj({ pluginId: id(), config: json() }), PluginView),
  /** 新版本多声明的权限要在 grantedPermissions 里重新同意,否则 forbidden(detail.missing 列出缺的)。 */
  "plugins.update": method(obj({ pluginId: id(), version: opt(str({ max: 50 })), grantedPermissions: opt(arr(str({ min: 1, max: 100 }))) }), PluginView),
  "plugins.uninstall": method(obj({ pluginId: id() }), Ok),

  // ---- Slash 命令 ----
  /** 当前会话可用命令(宿主内置 + 已启用插件 + 会话内联系人能力),输入框敲 / 时弹出。 */
  "commands.list": method(obj({ roomId: id(), prefix: opt(str({ max: 32 })) }), obj({ commands: arr(SlashCommand) })),

  // ---- 设置 ----
  "settings.get": method(Empty, SettingsView),
  "settings.update": method(
    obj({ defaultHarness: opt(oneOf(HARNESSES)), defaultSpeakingModel: opt(str({ max: 200 })), defaultComputeModel: opt(str({ max: 200 })), defaultEffort: opt(oneOf(EFFORTS)), timezone: opt(str({ min: 1, max: 64 })) }),
    SettingsView,
  ),
} as const;

export type MethodTable = typeof METHODS;
export type MethodName = keyof MethodTable;
export type ParamsOf<M extends MethodName> = MethodTable[M]["params"] extends Schema<infer P> ? P : never;
export type ResultOf<M extends MethodName> = MethodTable[M]["result"] extends Schema<infer R> ? R : never;
export const METHOD_NAMES = Object.freeze(Object.keys(METHODS) as MethodName[]);

// ---------- 错误 ----------
export const ERROR_CODES = ["invalid_params", "not_found", "conflict", "forbidden", "unavailable", "unknown_method", "internal"] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];
export const ApiError = obj({
  code: oneOf(ERROR_CODES),
  message: str({ max: 5000 }),
  /** conflict 时带当前版本;invalid_params 时带字段问题列表。 */
  detail: opt(json()),
});
export type ApiError = { code: ErrorCode; message: string; detail?: unknown };
export type ApiResult<M extends MethodName> = { ok: true; value: ResultOf<M> } | { ok: false; error: ApiError };
