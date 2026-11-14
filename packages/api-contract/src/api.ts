// 渲染进程经 preload 调用的方法表。每个方法 = 参数 schema + 结果 schema;主进程收到调用先校验参数,
// 回包前校验结果,渲染进程收到回包可再校验一次(开发模式)。方法名「域.动作」,新增只加不改。
import {
  ANNOUNCEMENT_ORDERS,
  AnnouncementView,
  CapabilityLibraryView,
  CommitmentView,
  ComputeProgress,
  ContactProfileView,
  ContactView,
  EFFORTS,
  ExternalEventView,
  FileEntry,
  HARNESSES,
  HelperEntry,
  HelperNote,
  HelperRoute,
  MarketplaceEntry,
  MemberRef,
  MessageView,
  ModelChangePreview,
  ModelSlot,
  PluginView,
  ReceiptView,
  RewindPreview,
  RewindResult,
  RoomView,
  RUN_STATUSES,
  RunEventView,
  RunHint,
  RunView,
  ScheduleView,
  SearchHit,
  SettingsView,
  SharedDocVersionView,
  SharedDocView,
  SlashCommand,
  SlashInvocation,
  TASK_STATES,
  TaskView,
  TrendSummaryView,
} from "./entities.ts";
import { DraftBody, DraftView } from "./draft.ts";
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
    obj({
      clientActionId: id(),
      name: str({ min: 1, max: 80 }),
      bio: opt(str({ max: 2000 })),
      speakingModel: opt(str({ max: 200 })),
      harness: opt(oneOf(HARNESSES)),
      computeModel: opt(ModelSlot),
      persona: opt(str({ max: 20000 })),
      /** 预检发现会让 Compute 不兼容时,不带它保存被拒(conflict,detail.reason="model-incompatible",detail.preview);用户看过预览确认后带 true 再存。 */
      confirmAffected: opt(bool()),
    }),
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
      /** 预设(人设原文);改了下一轮第 1 块就用新值。 */
      persona: opt(str({ max: 20000 })),
      /** 同 contacts.create。 */
      confirmAffected: opt(bool()),
      /** 个人 Compute 槽位数(AC-23);null 恢复宿主默认。 */
      computeSlots: opt(nullable(int({ min: 1, max: 64 }))),
    }),
    ContactView,
  ),
  /** 联系人主面板(AC-54):视图 + 预设 + 工作记忆 + 职责(承诺、在途任务、定时、所在会话)。 */
  "contacts.profile": method(obj({ contactId: id() }), ContactProfileView),
  "contacts.remove": method(obj({ contactId: id() }), Ok),
  /** 全局能力库里可勾选的 skill 与 MCP(AC-29)。联系人的 Compute 只加载它勾选的那些,本机全局的默认不进入。 */
  "capabilities.list": method(Empty, CapabilityLibraryView),

  // ---- 会话 ----
  "rooms.list": method(Empty, obj({ rooms: arr(RoomView) })),
  "rooms.get": method(obj({ roomId: id() }), RoomView),
  /** 打开与某联系人的私聊;已存在则返回原会话。 */
  "rooms.openDm": method(obj({ contactId: id() }), RoomView),
  "rooms.createGroup": method(obj({ clientActionId: id(), title: str({ min: 1, max: 200 }), members: arr(MemberRef, { max: 100 }) }), RoomView),
  "rooms.update": method(obj({ roomId: id(), title: opt(str({ min: 1, max: 200 })), pinned: opt(bool()), muted: opt(bool()), rules: opt(str({ max: 20000 })), expectedRulesVersion: opt(int({ min: 0 })), tempComputeSlots: opt(int({ min: 0, max: 64 })) }), RoomView),
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
  /**
   * 解散群(U03/D05):只有群主能解散,私聊 forbidden。先停本群全部在途任务(Cancel → 停 Compute)并进 dissolution=dissolving,
   * 从这一刻起只读:用户与联系人都不能再在这里发言、新消息不送达联系人、本群定时停用;每个任务都收到真实停止确认后才
   * dissolved,本群临时 Compute 槽位清零(AC-23/U09:确认前不归还)。记录保留可查。重复调用不重复停止,返回当前状态。
   */
  "rooms.dissolve": method(obj({ roomId: id(), clientActionId: id() }), RoomView),
  /**
   * 群内禁言(U03;候选,语义待用户定,只做最小一项):禁言期间这个联系人在这个群发的消息(回复、接活卡片、交付)被宿主拒收并记违规,
   * 它下一轮输入里写明自己在这个群被禁言;别的都不变——在途任务照跑、交付不改投、私聊不受影响、不另发通知。
   * 只有群主能做,私聊 forbidden。muted=false 解除;状态没变什么都不改。
   */
  "rooms.muteMember": method(obj({ roomId: id(), contactId: id(), muted: bool(), clientActionId: id() }), RoomView),
  /**
   * 清空聊天记录(U23):只在你这一端隐藏这个会话此刻为止的全部消息,之后的新消息照常显示;联系人上下文与其他成员不受影响(与撤回不同)。
   * 只追加一条隐藏记录,原消息不改。clientActionId 幂等。
   */
  "rooms.clearHistory": method(obj({ roomId: id(), clientActionId: id() }), obj({ room: RoomView, clearedUptoSeq: seq() })),

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
  /**
   * 翻页取消息。aroundSeq(与 beforeSeq/afterSeq 互斥):返回以该条为中心、包含该条的一页,搜索结果跳转用;
   * 此时 hasMore 表示前面还有,hasMoreAfter 表示后面还有。
   */
  "messages.list": method(
    obj({ roomId: id(), threadRootSeq: opt(nullable(seq())), beforeSeq: opt(seq()), afterSeq: opt(seq()), aroundSeq: opt(seq()), ...Page }),
    obj({ messages: arr(MessageView), hasMore: bool(), hasMoreAfter: opt(bool()) }),
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
      /** 发送时输入框草稿的 draftVer(AC-24);成功后服务端只清这一版草稿,等回执期间新打的字保留。不带则不动草稿。 */
      draftVer: opt(int({ min: 0 })),
    }),
    MessageView,
  ),
  "messages.edit": method(obj({ roomId: id(), seq: seq(), text: str({ max: 100000 }) }), MessageView),
  /** 撤回:对所有人生效,原文不再进任何联系人的上下文、搜索不再返回(AC-08)。群里群主能撤回任何人的消息(U26),其余只能撤回自己的。 */
  "messages.retract": method(obj({ roomId: id(), seq: seq() }), MessageView),
  /**
   * 删除 / 多选删除(U23/U100):只在你这一端隐藏所选消息——messages.list、搜索、会话预览不再返回;联系人上下文与其他成员不受影响(与撤回不同)。
   * 逐条给结果:不在这个会话里的 seq 记 not_found,不影响其他条。只追加隐藏记录,原消息不改(AC-05)。clientActionId 幂等(重放返回原结果)。
   */
  "messages.delete": method(
    obj({ roomId: id(), seqs: arr(seq(), { max: 500 }), clientActionId: id() }),
    obj({ results: arr(obj({ seq: seq(), ok: bool(), error: nullable(obj({ code: oneOf(["not_found"] as const), message: str({ max: 500 }) })) })) }),
  ),
  "messages.react": method(obj({ roomId: id(), seq: seq(), emoji: str({ min: 1, max: 32 }), on: bool() }), MessageView),
  "messages.receipts": method(obj({ roomId: id(), seq: seq() }), ReceiptView),
  // ---- 输入框草稿(AC-24、AC-37 ②:按会话持久化,切窗口与重启都不丢;不是消息,不送达任何联系人) ----
  /** 取某会话的草稿;没有时返回 draftVer = 0 的空草稿。 */
  "drafts.get": method(obj({ roomId: id() }), DraftView),
  /** 按 draftVer 做 CAS:expectedVer 必须等于服务端当前版本(没有草稿为 0),draft.draftVer 必须更大;否则 conflict,detail.current 是当前草稿。 */
  "drafts.save": method(obj({ roomId: id(), expectedVer: int({ min: 0 }), draft: DraftBody }), DraftView),

  /** 上传附件(渲染进程先把文件交给 preload 拿到本地路径)。 */
  "attachments.add": method(obj({ path: str({ min: 1, max: 4096 }) }), obj({ ref: id(), name: str(), mime: str(), bytes: int({ min: 0 }) })),

  /** 会话里出现过的文件(附件 + 任务产出),按出现顺序;文件列表选中后用 files.read 取内容(AC-57)。 */
  "files.list": method(obj({ roomId: id() }), obj({ files: arr(FileEntry) })),
  /** 读文件内容:文本给 text,其余给 base64;超过 maxBytes(默认 1 MiB)截断并标 truncated。只能读用户所在会话里出现过的 ref。 */
  "files.read": method(
    obj({ ref: id(), maxBytes: opt(int({ min: 1, max: 16 * 1024 * 1024 })) }),
    obj({ ref: id(), name: str({ max: 500 }), mime: str({ max: 200 }), bytes: int({ min: 0 }), encoding: oneOf(["text", "base64"] as const), content: str(), truncated: bool() }),
  ),

  // ---- 搜索(AC-25)----
  /**
   * 在自己所在的会话里按关键词搜消息正文与附件名;空白分隔的多个词全部命中才算,% _ 按字面匹配。
   * 撤回的消息搜不到;编辑过的按最新文字匹配。按时间倒序,nextCursor 不为 null 时带上它取下一页。
   * 指定 roomId 时只搜这个会话(不存在 not_found,不是成员 forbidden)。
   */
  "search.messages": method(
    obj({ query: str({ min: 1, max: 200 }), roomId: opt(id()), cursor: opt(nullable(str({ max: 1000 }))), limit: opt(int({ min: 1, max: 100 })) }),
    obj({ hits: arr(SearchHit), nextCursor: nullable(str({ max: 1000 })) }),
  ),

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
  /** 代码任务受控合入目标分支(AC-22):审查通过、交付后才能合;主线未变快进,主线已推进则合并后重验;
   *  冲突或重验失败返回 workspace.state=W5_Conflict(目标分支未动)。验收交付卡时宿主会自动发起,这里是重试入口。 */
  "tasks.integrate": method(obj({ taskId: id(), clientActionId: id() }), TaskView),
  /**
   * 改挂一条补充(E5b,AC-15):把会话 roomId 里的 #seq 从 fromTaskId 移到 toTaskId。源任务不取消,版本 +1 并重放其余补充;
   * expectedBindingVersion 取源任务 TaskView.bindingVersion(没有就是 0),对不上返回 conflict(detail.currentVer);同一 clientActionId 或重复改挂幂等。
   */
  "tasks.rebindFollowUp": method(
    obj({ roomId: id(), seq: seq(), fromTaskId: id(), toTaskId: id(), expectedBindingVersion: int({ min: 0 }), clientActionId: id() }),
    obj({ from: TaskView, to: TaskView }),
  ),

  // ---- 工件 ----
  /** 点开交付卡里的工件(AC-04):返回快照的本地路径与 sha256(与卡片里的相同);文本类 ≤1 MB 直接带回正文,其余 text 为 null。 */
  "artifacts.get": method(
    obj({ ref: id() }),
    obj({ ref: id(), name: str({ max: 500 }), mime: str({ max: 200 }), bytes: int({ min: 0 }), sha256: str({ min: 64, max: 64, pattern: /^[0-9a-f]{64}$/ }), path: str({ max: 4096 }), text: nullable(str({ max: 1_048_576 })) }),
  ),

  // ---- 运行台账(AC-43):全景画板与查询读同一张台账;用户本人看全部 ----
  "runs.list": method(obj({ roomId: opt(id()), contactId: opt(id()), statuses: opt(arr(oneOf(RUN_STATUSES))), ...Page }), obj({ runs: arr(RunView), hints: arr(RunHint) })),
  "runs.get": method(obj({ runId: id() }), obj({ run: RunView, children: arr(RunView), events: arr(RunEventView) })),
  /** 重跑失败 / 中断 / 没跑完的单元(用户本人明确发起);拒绝时 conflict,detail 带 reason 与「未做:原因」 */
  "runs.rerun": method(
    obj({ runId: id(), clientActionId: id() }),
    obj({ runId: id(), mode: oneOf(["same_session", "new_session"] as const), taskId: nullable(id()), attempt: int({ min: 1 }) }),
  ),

  // ---- 承诺账本 ----
  "commitments.list": method(obj({ contactId: opt(id()), roomId: opt(id()), status: opt(oneOf(["active", "done", "revoked", "superseded", "blocked"] as const)) }), obj({ commitments: arr(CommitmentView) })),
  "commitments.revoke": method(obj({ commitmentId: id(), clientActionId: id() }), CommitmentView),

  // ---- 群聊动向摘要(U80,D21.2–D21.4):只读;由联系人「每 N 条消息」的承诺触发生成,见 CommitmentView.trigger ----
  /** 一个会话的摘要,按区间从新到旧(时间轴用);默认每段只给最新版本,includeSuperseded 连旧版本一起给。beforeToSeq 翻页。不在这个会话 forbidden。 */
  "summaries.list": method(
    obj({ roomId: id(), beforeToSeq: opt(seq()), includeSuperseded: opt(bool()), limit: opt(int({ min: 1, max: 200 })) }),
    obj({ summaries: arr(TrendSummaryView), hasMore: bool() }),
  ),
  "summaries.get": method(obj({ summaryId: id() }), TrendSummaryView),
  /**
   * 重做一份已过期(stale)或没生成成(failed)的摘要:同一区间出新版本(generating,结果走 summary.updated),重新读这段现在可见的消息。
   * 其它状态、已有更新版本、联系人已不在这个会话 → conflict;同一 clientActionId 重放返回同一份。
   */
  "summaries.regenerate": method(obj({ summaryId: id(), clientActionId: id() }), TrendSummaryView),

  // ---- 共享文档(AC-21:单一提交点,带基线版本提交,版本冲突不静默覆盖) ----
  "docs.list": method(obj({ roomId: opt(id()) }), obj({ docs: arr(SharedDocView) })),
  /** 读权威版本;给 version 读版本链里的那一版。 */
  "docs.get": method(obj({ docId: id(), version: opt(int({ min: 1 })) }), SharedDocView),
  /** 新建,版本为 1;同一 clientActionId 重发返回同一份文档。 */
  "docs.create": method(obj({ clientActionId: id(), title: str({ min: 1, max: 200 }), content: str({ max: 1_000_000 }), roomId: opt(nullable(id())) }), SharedDocView),
  /**
   * 提交修改:baseVersion = 读到的 version。版本已变 → 错误 conflict,detail.currentVer 是当前版本,什么都不写;
   * 同一 requestId 重试 → replayed=true、committedVersion 为当初生效的版本,不重复写;同一 requestId 换了内容 → conflict。
   */
  "docs.commit": method(
    obj({ docId: id(), requestId: id(), baseVersion: int({ min: 1 }), content: str({ max: 1_000_000 }), title: opt(str({ min: 1, max: 200 })) }),
    obj({ doc: SharedDocView, committedVersion: int({ min: 1 }), replayed: bool() }),
  ),
  /** 版本链,从新到旧。 */
  "docs.history": method(obj({ docId: id(), ...Page }), obj({ versions: arr(SharedDocVersionView) })),

  // ---- 定时(cron) ----
  /** 三视角(AC-53):roomId=群视角,contactId=联系人视角,都不给=总览。order 默认 next-run(下次触发早的在前,停用的在后,同时按创建顺序);排序待定(D28 待确认 ②)。 */
  "schedules.list": method(obj({ contactId: opt(id()), roomId: opt(id()), order: opt(oneOf(["next-run", "created"] as const)) }), obj({ schedules: arr(ScheduleView) })),
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
        /** sha256(可选,64 位小写十六进制):给了就必须与下载内容一致,否则 forbidden;不给则记下实际 hash、标未核对。 */
        url: obj({ kind: lit("url"), url: str({ min: 1, max: 4096, pattern: /^https:\/\// }), sha256: opt(str({ pattern: /^[0-9a-f]{64}$/ })) }),
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
  /** 在隔离进程里运行数据源插件,拉一次外部事件(宿主盖章、标不可信)。不给 sourceId 就拉插件声明的全部来源;
   *  单个来源失败进 failures,不合契约的事件进 rejected,不影响其它来源。插件停用 → conflict;没有 entry → unavailable。 */
  "plugins.pull": method(
    obj({ pluginId: id(), sourceId: opt(str({ min: 1, max: 4096 })) }),
    obj({
      events: arr(ExternalEventView),
      rejected: arr(obj({ sourceId: str({ max: 4096 }), index: int({ min: 0 }), reason: str({ max: 2000 }) })),
      failures: arr(obj({ sourceId: str({ max: 4096 }), reason: str({ max: 100 }), detail: str({ max: 2000 }) })),
    }),
  ),
  /** 经输出渠道插件外发一次。actionId 由调用方生成并在重试时复用:已确认的复用回执不再发;结果未知时 B2 渠道拒绝自动重发,
   *  B1 只在服务商幂等保留期内用同一 actionId 重试。state=rejected 是宿主没发(reason 说明,如 payload-mismatch)。 */
  "plugins.send": method(
    obj({ pluginId: id(), actionId: id(), payload: str({ min: 1, max: 100000 }) }),
    obj({
      state: oneOf(["confirmed", "delivery-unknown", "rejected"] as const),
      receiptId: nullable(str({ max: 2000 })),
      deduplicated: bool(),
      reason: nullable(str({ max: 100 })),
      detail: nullable(str({ max: 2000 })),
    }),
  ),

  // ---- Slash 命令 ----
  /** 当前会话可用命令(宿主内置 + 已启用插件 + 会话内联系人能力),输入框敲 / 时弹出。 */
  "commands.list": method(obj({ roomId: id(), prefix: opt(str({ max: 32 })) }), obj({ commands: arr(SlashCommand) })),

  // ---- Helper(AC-52)----
  /** Helper 这一次能读什么:全局入口默认不读任何聊天,readRoomIds 按需点名用户在场的聊天;侧栏/@ 读当前聊天。 */
  "helper.context": method(
    obj({ entry: HelperEntry, readRoomIds: opt(arr(id(), { max: 20 })), limit: opt(int({ min: 1, max: 500 })) }),
    obj({ route: HelperRoute, rooms: arr(obj({ roomId: id(), title: str({ max: 200 }), messages: arr(MessageView) })) }),
  ),
  /** 全局面板 / 侧栏里记一条问答(不进会话、不送联系人)。clientActionId 幂等。mention 入口不能用。 */
  "helper.note": method(obj({ entry: HelperEntry, role: oneOf(["user", "helper"] as const), text: str({ min: 1, max: 100000 }), clientActionId: id() }), HelperNote),
  "helper.history": method(obj({ entry: HelperEntry, ...Page }), obj({ notes: arr(HelperNote) })),
  /** 聊天里 @Helper 时的公开回复:作为 helper 发言者的一条消息回复那条 @ 它的用户消息。只有 mention 入口能用。 */
  "helper.post": method(obj({ entry: HelperEntry, text: str({ min: 1, max: 100000 }), clientActionId: id() }), MessageView),
  // ---- 模型配置(AC-32)----
  /** 保存前预检:按提议的改动算出每位联系人的生效值,列出受影响的下游与冲突;不落盘。 */
  "models.preview": method(
    obj({
      change: tagged("kind", {
        defaults: obj({ kind: lit("defaults"), defaultHarness: opt(oneOf(HARNESSES)), defaultSpeakingModel: opt(str({ max: 200 })), defaultComputeModel: opt(str({ max: 200 })), defaultEffort: opt(oneOf(EFFORTS)) }),
        contact: obj({ kind: lit("contact"), contactId: id(), speakingModel: opt(str({ max: 200 })), harness: opt(oneOf(HARNESSES)), computeModel: opt(ModelSlot) }),
        "batch-replace": obj({ kind: lit("batch-replace"), from: str({ min: 1, max: 200 }), to: str({ min: 1, max: 200 }) }),
      } as const),
    }),
    ModelChangePreview,
  ),
  /** 把模型 X 批量换成 Y:apply 不为 true 时只预览;有冲突时不带 confirmAffected 应用被拒(conflict)。在途与历史任务的模型快照不改。 */
  "models.batchReplace": method(
    obj({ clientActionId: id(), from: str({ min: 1, max: 200 }), to: str({ min: 1, max: 200 }), apply: opt(bool()), confirmAffected: opt(bool()) }),
    obj({ applied: bool(), preview: ModelChangePreview }),
  ),

  // ---- 设置 ----
  "settings.get": method(Empty, SettingsView),
  "settings.update": method(
    obj({
      defaultHarness: opt(oneOf(HARNESSES)),
      defaultSpeakingModel: opt(str({ max: 200 })),
      defaultComputeModel: opt(str({ max: 200 })),
      defaultEffort: opt(oneOf(EFFORTS)),
      timezone: opt(str({ min: 1, max: 64 })),
      /** 模型能力声明(每个模型能在哪些 Harness 上跑),是三时机兼容性校验的判据;整表替换。 */
      models: opt(arr(obj({ id: str({ min: 1, max: 200 }), label: str({ max: 200 }), vendor: str({ max: 64 }), harnesses: arr(oneOf(HARNESSES)) }), { max: 500 })),
      /** 同 contacts.create:预检有冲突时不带 true 保存被拒。 */
      confirmAffected: opt(bool()),
    }),
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
