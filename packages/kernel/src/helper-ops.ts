// Helper 的软件操作能力清单(U04「手动能做的,helper 也能做(在权限内)」;U05 普通联系人不加载;D07.0 / D28.1 / AC-52)。
// 清单 = 服务接口(@g-group/api-contract 的方法表)的受控子集,纯数据,是 Helper 专属 MCP、CLI、skill 共用的唯一业务能力来源:
//   每项一个服务方法,带种类、参数 JSON Schema 与中文说明。
//   kind = read          只读;
//   kind = write         改状态,可撤回或可再改;
//   kind = irreversible  不可逆或授权类(删除、卸载、回退、授予插件权限等)。代码不设确认门禁(软提示不做成功能,DM#2565):
//                        工具说明与 skill 写明「先跟用户说清,等用户本人同意再调」。
// 排除清单写明哪些方法按权限不给 Helper(以用户身份发言、验收与授权只来自用户本人等,U99/AC-20/AC-28),每条带理由;服务层据此拒收。
// 清单与服务方法表一一对账由服务层测试做(内核不依赖接口合同包);这里只定义形状与端口,不做 I/O。

export type HelperOpKind = "read" | "write" | "irreversible";
export type JsonSchema = Readonly<Record<string, unknown>>;
export interface HelperOp {
  /** 工具名(^[a-zA-Z0-9_-]{1,64}$);一般是方法名把「.」换成「_」,messages.list 叫 read_room。 */
  readonly name: string;
  /** 对应的服务方法(「域.动作」)。 */
  readonly method: string;
  readonly kind: HelperOpKind;
  /** 一句话中文标签,用在操作记录里。 */
  readonly label: string;
  /** 给模型看的中文说明。 */
  readonly description: string;
  /** 参数 JSON Schema(type: object)。clientActionId 不在这里,由宿主按每次调用生成。 */
  readonly params: JsonSchema;
}
export interface HelperExclusion {
  readonly method: string;
  readonly reason: string;
}

// ---- 参数 schema 的小构件 ----
const s = (description: string, extra: Record<string, unknown> = {}): JsonSchema => ({ type: "string", minLength: 1, description, ...extra });
const text = (description: string, max: number): JsonSchema => ({ type: "string", maxLength: max, description });
const i = (description: string, min = 0, max?: number): JsonSchema => ({ type: "integer", minimum: min, ...(max !== undefined ? { maximum: max } : {}), description });
const b = (description: string): JsonSchema => ({ type: "boolean", description });
const e = (values: readonly string[], description: string): JsonSchema => ({ type: "string", enum: [...values], description });
const a = (items: JsonSchema, description: string, maxItems?: number): JsonSchema => ({ type: "array", items, ...(maxItems !== undefined ? { maxItems } : {}), description });
const o = (properties: Record<string, JsonSchema>, required: readonly string[] = [], description?: string): JsonSchema => ({
  type: "object",
  properties,
  required: [...required],
  additionalProperties: false,
  ...(description ? { description } : {}),
});
const nul = (x: JsonSchema): JsonSchema => ({ ...x, type: [x.type as string, "null"] });

const HARNESS = ["claude-code", "codex"] as const;
const EFFORT = ["low", "medium", "high", "xhigh", "max"] as const;
const TASK_STATE = ["T1_Open", "T2_Claimed", "T3_Running", "T4b_BlockedOnHuman", "T5_InReview", "T7_Delivering", "T8a_Delivered", "T8_Accepted", "T9_StopRequested", "T10_Cancelled", "T11_Failed"] as const;
const RUN_STATUS = ["queued", "running", "waiting_user", "done", "failed", "interrupted", "orphaned"] as const;
const member = o({ kind: e(["user", "contact"], "成员种类:user 是用户本人,contact 是联系人"), id: s("成员 id(联系人 id 用 contacts_list 查)") }, ["kind", "id"], "会话成员");
const modelSlot = o(
  { mode: e(["inherit", "follow-speaking", "explicit"], "inherit 继承全局默认;follow-speaking 跟随说话模型;explicit 单独指定"), model: text("explicit 时的模型 id", 200), effort: e(EFFORT, "推理强度") },
  ["mode"],
  "Compute 模型槽位",
);
const contactId = s("联系人 id");
const roomId = s("会话 id(群或私聊),用 rooms_list 查");
const taskId = s("任务 id");
const limit = (max: number) => i(`最多返回几条(1–${max})`, 1, max);

const op = (method: string, kind: HelperOpKind, label: string, description: string, params: JsonSchema, name = method.replace(".", "_")): HelperOp =>
  Object.freeze({ name, method, kind, label, description, params: Object.freeze(params) });

/** Helper 的能力清单(封闭)。顺序即 tools/list 的顺序。 */
export const HELPER_OPS: readonly HelperOp[] = Object.freeze([
  // ---- 联系人 ----
  op("contacts.list", "read", "列出联系人", "列出全部联系人(id、名字、模型)。按名字找联系人 id 时先调它。", o({})),
  op("contacts.get", "read", "查看联系人", "看一位联系人的配置。", o({ contactId }, ["contactId"])),
  op("contacts.profile", "read", "查看联系人资料", "联系人主面板:预设、工作记忆、承诺、在途任务、定时、所在会话。", o({ contactId }, ["contactId"])),
  op("capabilities.list", "read", "列出能力库", "全局能力库里可勾选给联系人 Compute 的 skill 与 MCP。", o({})),
  op(
    "contacts.create",
    "write",
    "新建联系人",
    "新建一位联系人。模型改动预检有冲突时会被拒(conflict),先把预览告诉用户,用户同意后带 confirmAffected=true 再建。",
    o({ name: text("名字(1–80 字)", 80), bio: text("简介", 2000), speakingModel: text("说话模型 id;不填用全局默认", 200), harness: e(HARNESS, "Compute 运行时"), computeModel: modelSlot, persona: text("预设(人设原文)", 20000), confirmAffected: b("用户已看过模型改动预览并同意") }, ["name"]),
  ),
  op(
    "contacts.update",
    "write",
    "修改联系人",
    "改联系人的名字、简介、头像、模型、工具、Compute 资产、预设或个人 Compute 槽位数;只传要改的字段。",
    o(
      {
        contactId,
        name: text("名字", 80),
        bio: text("简介", 2000),
        avatar: nul(text("头像地址;null 清除", 2048)),
        speakingModel: text("说话模型 id", 200),
        harness: e(HARNESS, "Compute 运行时"),
        computeModel: modelSlot,
        tools: a(text("工具名", 200), "Compute 可用工具(整表替换)"),
        computeAssets: a(o({ name: text("资产名", 200), kind: e(["mcp", "skill", "script"], "资产种类") }, ["name", "kind"]), "Compute 资产(整表替换)"),
        persona: text("预设(人设原文)", 20000),
        confirmAffected: b("用户已看过模型改动预览并同意"),
        computeSlots: nul(i("个人 Compute 槽位数;null 恢复默认", 1, 64)),
      },
      ["contactId"],
    ),
  ),
  op("contacts.remove", "irreversible", "删除联系人", "删除一位联系人(不可恢复)。", o({ contactId }, ["contactId"])),
  // ---- 会话 ----
  op("rooms.list", "read", "列出会话", "列出用户所在的全部群与私聊(id、标题、成员、置顶、免打扰)。", o({})),
  op("rooms.get", "read", "查看会话", "看一个会话的资料与成员。", o({ roomId }, ["roomId"])),
  op("rooms.openDm", "write", "打开私聊", "打开与某联系人的私聊;已存在则返回原会话。", o({ contactId }, ["contactId"])),
  op(
    "rooms.createGroup",
    "write",
    "建群",
    "新建一个群并拉入成员(用户本人自动在群里)。要把当前聊天的几条消息带过去作背景时给 fromRoomId 与 backgroundSeqs,原聊天不会多消息。",
    o({ title: text("群名(1–200 字)", 200), members: a(member, "要拉进来的成员", 100), fromRoomId: s("背景来自哪个会话"), backgroundSeqs: a(i("消息 seq"), "带过去作背景的消息 seq", 50) }, ["title", "members"]),
  ),
  op(
    "rooms.update",
    "write",
    "修改会话",
    "改群名、置顶、免打扰、群规或临时 Compute 槽位;只传要改的字段。",
    o({ roomId, title: text("群名", 200), pinned: b("置顶"), muted: b("免打扰"), rules: text("群规原文", 20000), expectedRulesVersion: i("改群规时的基线版本"), tempComputeSlots: i("临时 Compute 槽位数", 0, 64) }, ["roomId"]),
  ),
  op("rooms.addMembers", "write", "拉人进群", "把成员拉进一个群。", o({ roomId, members: a(member, "要拉进来的成员", 100) }, ["roomId", "members"])),
  op("rooms.removeMember", "irreversible", "把成员移出群", "把成员移出群;stopTasks=true 时先停掉他在这个群里的在途任务。", o({ roomId, member, stopTasks: b("同时停掉他在这个群的在途任务") }, ["roomId", "member"])),
  op("rooms.rewindPreview", "read", "预览回退", "私聊回退预览:列出回退点之后会撤下的消息、会取消的任务与作废的承诺;只读。回退前先用它给用户看。", o({ roomId, toSeq: i("回退到哪条消息的 seq") }, ["roomId", "toSeq"])),
  op("rooms.rewind", "irreversible", "回退私聊", "私聊回退:回退点之后的消息撤下、来源于它们的在途任务取消、承诺作废。", o({ roomId, toSeq: i("回退到哪条消息的 seq") }, ["roomId", "toSeq"])),
  // ---- 群公告 ----
  op("announcements.list", "read", "列出群公告", "列出一个群当前有效的公告。", o({ roomId, order: e(["created-asc", "created-desc"], "排序") }, ["roomId"])),
  op("announcements.add", "write", "新增群公告", "给群新增一条公告(不覆盖已有的)。", o({ roomId, text: text("公告正文(1–20000 字)", 20000) }, ["roomId", "text"])),
  op("announcements.update", "write", "修改群公告", "改一条公告的正文。", o({ announcementId: s("公告 id"), text: text("新正文", 20000), expectedVersion: i("基线版本", 1) }, ["announcementId", "text"])),
  op("announcements.remove", "irreversible", "撤下群公告", "撤下一条公告。", o({ announcementId: s("公告 id"), expectedVersion: i("基线版本", 1) }, ["announcementId"])),
  // ---- 消息 ----
  op("messages.list", "read", "读会话消息", "读一个用户在场的会话的最近消息。全局入口默认看不到任何聊天,需要时用它点名读;侧栏和 @ 入口只能读当前聊天。", o({ roomId, limit: limit(500) }, ["roomId"]), "read_room"),
  op("search.messages", "read", "搜索消息", "在用户所在的会话里按关键词搜消息正文与附件名;侧栏和 @ 入口要带当前聊天的 roomId。", o({ query: text("关键词(空白分隔的多个词全部命中)", 200), roomId: s("只搜这个会话"), cursor: nul(text("翻页游标", 1000)), limit: limit(100) }, ["query"])),
  op("messages.receipts", "read", "查看已读回执", "看一条消息谁已读。", o({ roomId, seq: i("消息 seq") }, ["roomId", "seq"])),
  op("messages.react", "write", "表情回应", "给一条消息加或去掉表情回应。", o({ roomId, seq: i("消息 seq"), emoji: text("表情", 32), on: b("true 加上,false 去掉") }, ["roomId", "seq", "emoji", "on"])),
  op("messages.retract", "irreversible", "撤回消息", "撤回用户本人的一条消息。", o({ roomId, seq: i("消息 seq") }, ["roomId", "seq"])),
  // ---- 文件与工件 ----
  op("files.list", "read", "列出会话文件", "列出会话里出现过的文件(附件与任务产出)。", o({ roomId }, ["roomId"])),
  op("files.read", "read", "读文件", "读会话里出现过的一个文件的内容。", o({ ref: s("文件 ref"), maxBytes: i("最多读多少字节", 1, 16 * 1024 * 1024) }, ["ref"])),
  op("artifacts.get", "read", "查看工件", "打开交付卡里的工件:路径、sha256 与文本正文。", o({ ref: s("工件 ref") }, ["ref"])),
  // ---- 任务 ----
  op("tasks.list", "read", "列出任务", "按会话、联系人、状态列任务。", o({ roomId: s("会话 id"), contactId: s("联系人 id"), states: a(e(TASK_STATE, "任务状态"), "只看这些状态"), limit: limit(500) })),
  op("tasks.get", "read", "查看任务", "看一个任务的详情。", o({ taskId }, ["taskId"])),
  op("tasks.progress", "read", "查看任务进度", "看一个任务的 Compute 进度。", o({ taskId, afterAt: s("只看这个时间之后的(ISO-8601)"), limit: limit(500) }, ["taskId"])),
  op("tasks.create", "write", "新建任务", "在会话里新建一个任务;指定负责人时由他认领开工,不指定就停在待认领。", o({ roomId, title: text("任务标题(1–500 字)", 500), description: text("任务描述", 20000), ownerContactId: s("负责人联系人 id(必须在这个会话里)") }, ["roomId", "title"])),
  op("tasks.importCsv", "write", "CSV 转任务", "把 CSV(第一行是表头)每行建成该群的一个待认领任务;返回建出的任务与逐行错误。", o({ roomId, csv: text("CSV 原文(RFC 4180)", 1_000_000), titleColumn: text("标题列的表头名;不填自动找 title/标题/任务,找不到用第一列", 200), assigneeColumn: text("负责人列的表头名(填联系人名字或 id);不填就都待认领", 200) }, ["roomId", "csv"])),
  op("tasks.assign", "write", "指派任务", "给还没人负责的任务指定负责人,由他认领开工。", o({ taskId, contactId }, ["taskId", "contactId"])),
  op("tasks.cancel", "irreversible", "取消任务", "取消一个任务,停掉它的 Compute。", o({ taskId }, ["taskId"])),
  op("tasks.integrate", "irreversible", "合入代码任务", "代码任务受控合入目标分支。", o({ taskId }, ["taskId"])),
  op(
    "tasks.rebindFollowUp",
    "write",
    "改挂补充",
    "把会话里的一条补充从一个任务改挂到另一个任务。",
    o({ roomId, seq: i("补充消息 seq"), fromTaskId: s("原任务 id"), toTaskId: s("目标任务 id"), expectedBindingVersion: i("原任务的 bindingVersion") }, ["roomId", "seq", "fromTaskId", "toTaskId", "expectedBindingVersion"]),
  ),
  // ---- 运行台账 ----
  op("runs.list", "read", "列出运行单元", "运行台账:按会话、联系人、状态列单元与提示。", o({ roomId: s("会话 id"), contactId: s("联系人 id"), statuses: a(e(RUN_STATUS, "状态"), "只看这些状态"), limit: limit(500) })),
  op("runs.get", "read", "查看运行单元", "看一个运行单元、它的子单元与事件。", o({ runId: s("单元 id") }, ["runId"])),
  op("runs.rerun", "write", "重跑运行单元", "重跑失败、中断或没跑完的单元(用户本人要求时)。", o({ runId: s("单元 id") }, ["runId"])),
  // ---- 承诺 ----
  op("commitments.list", "read", "列出承诺", "按联系人、会话、状态列承诺。", o({ contactId: s("联系人 id"), roomId: s("会话 id"), status: e(["active", "done", "revoked", "superseded", "blocked"], "状态") })),
  op("commitments.revoke", "irreversible", "撤销承诺", "撤销一条承诺。", o({ commitmentId: s("承诺 id") }, ["commitmentId"])),
  // ---- 定时 ----
  op("schedules.list", "read", "列出定时", "列定时:给 roomId 是群视角,给 contactId 是联系人视角,都不给是总览。", o({ contactId: s("联系人 id"), roomId: s("会话 id"), order: e(["next-run", "created"], "排序") })),
  op("schedules.preview", "read", "预览定时", "校验 cron 与时区,给出接下来几次触发时间。", o({ cron: text("cron 表达式", 200), tz: text("时区,如 Asia/Shanghai", 64), count: i("给几次", 1, 20) }, ["cron", "tz"])),
  op("schedules.history", "read", "查看定时历史", "看一个定时的触发历史。", o({ scheduleId: s("定时 id"), limit: limit(500) }, ["scheduleId"])),
  op(
    "schedules.create",
    "write",
    "新建定时",
    "让联系人按 cron 在某会话里定时做事。",
    o(
      {
        contactId,
        roomId,
        title: text("标题", 200),
        cron: text("cron 表达式", 200),
        tz: text("时区", 64),
        prompt: text("到点做什么", 20000),
        enabled: b("是否启用"),
        toleranceSec: i("容忍延迟秒数", 0, 86400),
        missedPolicy: e(["skip", "run-once"], "错过时怎么办"),
      },
      ["contactId", "roomId", "title", "cron", "tz", "prompt"],
    ),
  ),
  op(
    "schedules.update",
    "write",
    "修改定时",
    "改定时的字段;只传要改的。",
    o({ scheduleId: s("定时 id"), title: text("标题", 200), cron: text("cron 表达式", 200), tz: text("时区", 64), prompt: text("到点做什么", 20000), enabled: b("是否启用"), toleranceSec: i("容忍延迟秒数", 0, 86400), missedPolicy: e(["skip", "run-once"], "错过时怎么办") }, ["scheduleId"]),
  ),
  op("schedules.remove", "irreversible", "删除定时", "删除一个定时。", o({ scheduleId: s("定时 id") }, ["scheduleId"])),
  op("schedules.runNow", "write", "立即跑定时", "让一个定时立刻跑一次。", o({ scheduleId: s("定时 id") }, ["scheduleId"])),
  // ---- 插件 ----
  op("plugins.marketplace", "read", "浏览插件市场", "按关键词、种类查插件市场。", o({ query: text("关键词", 200), kind: e(["data-source", "outbound-channel", "ui-extension"], "插件种类") })),
  op("plugins.list", "read", "列出插件", "列出已装的插件。", o({})),
  op("plugins.get", "read", "查看插件", "看一个已装插件。", o({ pluginId: s("插件 id") }, ["pluginId"])),
  op(
    "plugins.install",
    "irreversible",
    "安装插件",
    "安装插件并授予权限(授权类)。grantedPermissions 只能列用户本人同意授予的权限键,少于插件声明的会被拒。",
    o(
      {
        source: {
          description: "安装来源",
          anyOf: [
            o({ kind: e(["marketplace"], "市场条目"), id: s("市场条目 id"), version: text("版本", 50) }, ["kind", "id"]),
            o({ kind: e(["local-path"], "本地目录"), path: text("目录路径", 4096) }, ["kind", "path"]),
            o({ kind: e(["url"], "https 地址"), url: text("https:// 地址", 4096), sha256: text("期望的 sha256(64 位小写十六进制)", 64) }, ["kind", "url"]),
          ],
        },
        grantedPermissions: a(text("权限键", 100), "用户本人同意授予的权限键"),
      },
      ["source", "grantedPermissions"],
    ),
  ),
  op("plugins.setEnabled", "write", "启停插件", "启用或停用一个插件。", o({ pluginId: s("插件 id"), enabled: b("true 启用,false 停用") }, ["pluginId", "enabled"])),
  op("plugins.configure", "write", "配置插件", "改插件配置(JSON,由插件自己校验)。", o({ pluginId: s("插件 id"), config: { description: "配置(任意 JSON)" } }, ["pluginId", "config"])),
  op("plugins.update", "irreversible", "更新插件", "更新插件;新版本多声明的权限要在 grantedPermissions 里重新列出用户本人同意的(授权类)。", o({ pluginId: s("插件 id"), version: text("版本", 50), grantedPermissions: a(text("权限键", 100), "用户本人同意授予的权限键") }, ["pluginId"])),
  op("plugins.pull", "write", "拉取插件数据", "在隔离进程里运行数据源插件,拉一次外部事件。", o({ pluginId: s("插件 id"), sourceId: text("只拉这个来源", 4096) }, ["pluginId"])),
  op("plugins.uninstall", "irreversible", "卸载插件", "卸载一个插件。", o({ pluginId: s("插件 id") }, ["pluginId"])),
  op("commands.list", "read", "列出可用命令", "一个会话里可用的 slash 命令。", o({ roomId, prefix: text("前缀", 32) }, ["roomId"])),
  // ---- 模型与设置 ----
  op(
    "models.preview",
    "read",
    "预览模型改动",
    "按提议的模型改动算出每位联系人的生效值、受影响的下游与冲突;不落盘。",
    o(
      {
        change: {
          description: "提议的改动",
          anyOf: [
            o({ kind: e(["defaults"], "全局默认"), defaultHarness: e(HARNESS, "默认运行时"), defaultSpeakingModel: text("默认说话模型", 200), defaultComputeModel: text("默认 Compute 模型", 200), defaultEffort: e(EFFORT, "默认推理强度") }, ["kind"]),
            o({ kind: e(["contact"], "某位联系人"), contactId, speakingModel: text("说话模型", 200), harness: e(HARNESS, "运行时"), computeModel: modelSlot }, ["kind", "contactId"]),
            o({ kind: e(["batch-replace"], "批量替换"), from: text("原模型", 200), to: text("新模型", 200) }, ["kind", "from", "to"]),
          ],
        },
      },
      ["change"],
    ),
  ),
  op("models.batchReplace", "write", "批量替换模型", "把模型 X 批量换成 Y;apply 不为 true 时只预览;有冲突时要用户同意后带 confirmAffected=true。", o({ from: text("原模型", 200), to: text("新模型", 200), apply: b("true 才真的替换"), confirmAffected: b("用户已看过冲突并同意") }, ["from", "to"])),
  op("settings.get", "read", "读设置", "读全局设置(默认模型、运行时、时区、模型能力表)。", o({})),
  op(
    "settings.update",
    "write",
    "改设置",
    "改全局设置;只传要改的字段。改默认模型有冲突时要用户同意后带 confirmAffected=true。",
    o(
      {
        defaultHarness: e(HARNESS, "默认运行时"),
        defaultSpeakingModel: text("默认说话模型", 200),
        defaultComputeModel: text("默认 Compute 模型", 200),
        defaultEffort: e(EFFORT, "默认推理强度"),
        timezone: text("时区", 64),
        models: a(o({ id: text("模型 id", 200), label: text("显示名", 200), vendor: text("厂商", 64), harnesses: a(e(HARNESS, "运行时"), "能跑在哪些运行时") }, ["id", "label", "vendor", "harnesses"]), "模型能力表(整表替换)", 500),
        confirmAffected: b("用户已看过冲突并同意"),
      },
      [],
    ),
  ),
]);

/** 按权限不给 Helper 的服务方法(每条带理由)。服务层测试核对:方法表 = 清单 ∪ 排除清单,且不相交。 */
export const HELPER_EXCLUDED: readonly HelperExclusion[] = Object.freeze(
  [
    { method: "session.hello", reason: "渲染进程握手,不是用户操作" },
    { method: "messages.send", reason: "Helper 不以用户身份在聊天里发言;@Helper 的回复以 helper 发言者出现" },
    { method: "messages.edit", reason: "改写用户本人的发言等同以用户身份发言" },
    { method: "rooms.markRead", reason: "已读位置代表用户本人看过(AC-46),Helper 不替用户标已读" },
    { method: "drafts.get", reason: "输入框草稿不需要 Helper 操作" },
    { method: "drafts.save", reason: "输入框草稿不需要 Helper 操作" },
    { method: "attachments.add", reason: "从本机任意路径取文件;Helper 只读会话里已有的文件(files.list/files.read)" },
    { method: "cards.act", reason: "卡片按钮含授权、验收与回答,只来自用户本人(U99/AC-20、AC-28);失败重试用 runs.rerun" },
    { method: "tasks.accept", reason: "验收交付要用户本人回复(AC-28)" },
    { method: "tasks.reject", reason: "退回交付要用户本人回复(AC-28)" },
    { method: "tasks.answer", reason: "回答联系人的提问与授权只来自用户本人(U99/AC-20)" },
    { method: "plugins.send", reason: "经输出渠道以用户身份对外发送,与 messages.send 同理不给 Helper" },
    { method: "docs.list", reason: "共享文档服务正由 PR #56 撤销" },
    { method: "docs.get", reason: "共享文档服务正由 PR #56 撤销" },
    { method: "docs.create", reason: "共享文档服务正由 PR #56 撤销" },
    { method: "docs.commit", reason: "共享文档服务正由 PR #56 撤销" },
    { method: "docs.history", reason: "共享文档服务正由 PR #56 撤销" },
    { method: "helper.context", reason: "Helper 自己的入口,不作为工具" },
    { method: "helper.note", reason: "Helper 自己的入口,不作为工具" },
    { method: "helper.history", reason: "Helper 自己的入口,不作为工具" },
    { method: "helper.post", reason: "Helper 自己的入口,不作为工具" },
    { method: "helper.ask", reason: "Helper 自己的入口,不作为工具" },
  ].map((x) => Object.freeze(x)),
);

/** 工具说明:不可逆或授权类统一标【先问用户】(软提示,写在说明里,代码不拦)。 */
export function toolDescription(op: HelperOp): string {
  return op.kind === "irreversible" ? `【先问用户】${op.description} 不可逆或授权类:调用前先跟用户说清要做什么,等用户本人明确同意再调。` : op.description;
}

const BY_NAME: ReadonlyMap<string, HelperOp> = new Map(HELPER_OPS.map((x) => [x.name, x]));
/** 按工具名找清单项;不在清单里(含排除清单的方法)返回 null。 */
export function helperOp(name: string): HelperOp | null {
  return (typeof name === "string" && BY_NAME.get(name)) || null;
}
/** 工具名(或方法名)落在排除清单里时给出那一条。 */
export function helperExclusion(name: string): HelperExclusion | null {
  return HELPER_EXCLUDED.find((x) => x.method === name || x.method.replace(".", "_") === name) ?? null;
}

// ---------------------------------------------------------------- Helper 脑子的端口
/** 这一次叫 Helper 的入口与路由(routeHelper 的结果)。 */
export interface HelperRouteInfo {
  readonly entry: "global" | "sidebar" | "mention";
  /** 侧栏 / @ 的当前聊天;全局为 null。 */
  readonly contextRoomId: string | null;
  /** @ 时回复的那条消息 seq;其余为 null。 */
  readonly replyToSeq: number | null;
}
export interface HelperMindInput {
  /** Helper 用的模型:全局默认说话模型(U70 只在联系人与 Compute 两处配模型,不另设 Helper 模型槽)。 */
  readonly model: string;
  readonly route: HelperRouteInfo;
  /** 用户这句话。 */
  readonly text: string;
  /** 按入口给的上下文:全局为空串(不带任何聊天);侧栏 / @ 是当前聊天的资料与最近消息。 */
  readonly context: string;
  /** 同一入口此前的问答(全局面板或这个侧栏的记录,不是聊天消息);@ 入口为空。 */
  readonly history: readonly { readonly role: "user" | "helper"; readonly text: string }[];
  /** Helper 的 skill 原文(何时、如何用这些工具),进系统提示。 */
  readonly skill: string;
}
export interface HelperToolResult {
  readonly ok: boolean;
  /** 回给模型的结果文字(JSON 或错误说明)。 */
  readonly text: string;
}
/**
 * MCP 客户端口(JSON-RPC 2.0):request 发一个带 id 的请求,返回 result;服务端回 error 时抛 McpError。
 * 宿主进程内用内存传输接 Helper MCP 服务(memoryMcpClient);工具清单从 tools/list 来,调用走 tools/call。
 */
export interface McpClient {
  request(method: string, params?: unknown): Promise<unknown>;
}
export interface HelperMindOutput {
  /** 给用户的文字回复。 */
  readonly reply: string;
  /** 本次的工具调用记录(按顺序)。 */
  readonly calls: readonly { readonly name: string; readonly args: unknown; readonly ok: boolean; readonly text: string }[];
}
export interface HelperMind {
  run(input: HelperMindInput, signal: AbortSignal, mcp: McpClient): Promise<HelperMindOutput>;
}

/** Helper 的系统提示与用户消息(pi 实现与替身共用):入口说明 + skill 原文;user 消息是当前聊天、此前对话与这句话。 */
export function renderHelperPrompt(input: HelperMindInput): { system: string; user: string } {
  const where =
    input.route.entry === "global"
      ? "这次从全局入口叫你:你看不到任何聊天记录。需要时先用 rooms_list 找会话 id,再用 read_room 读用户在场的会话。你的回复只出现在全局面板。"
      : input.route.entry === "sidebar"
        ? `这次从会话 ${input.route.contextRoomId} 的侧栏叫你:你能看到当前聊天(见用户消息)。你的回复只留在侧栏,不会发到聊天里,联系人看不到。`
        : `这次用户在会话 ${input.route.contextRoomId} 里 @ 了你:你能看到当前聊天(见用户消息)。你的回复会作为一条 Helper 消息出现在这个聊天里,回复用户那条 #${input.route.replyToSeq}。`;
  const system = ["你是 g-group 的 Helper,只为用户本人服务,帮他操作这个软件。", where, input.skill.trim()].filter(Boolean).join("\n\n");
  const parts: string[] = [];
  if (input.context.trim()) parts.push(`[当前聊天]\n${input.context}`);
  if (input.history.length) parts.push(`[此前在这个入口的对话]\n${input.history.map((h) => `${h.role === "user" ? "用户" : "Helper"}:${h.text}`).join("\n")}`);
  parts.push(`[用户这句话]\n${input.text}`);
  return { system, user: parts.join("\n\n") };
}
