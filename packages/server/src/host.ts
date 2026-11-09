// 本地宿主:把领域状态机、SQLite 存储、联系人注意循环、Compute 适配器和承诺账本拼成 P0 最小闭环(AC-30):
//   用户在私聊/群里发消息 → 机械送达每位成员联系人的注意循环 → 联系人一轮(五块重拼 → ContactMind)提出动作
//   → 宿主校验、分配 action_id、与游标/账本/任务同一事务落盘 → 起 Compute → Compute 语义事件回到联系人 → 联系人汇报/交付回聊天。
// 规则:只有联系人对外说话(Compute 不直接发言,AC-03);游标只在一轮落盘后推进(AC-31);发送前检出更新的用户消息就放弃本轮重跑(AC-31 ④);
// 发送入库端按 action_id 去重(AC-31 ③);消息接走即已读(AC-46)。
// 失败轮次 A×B 容错(AC-36,「失败轮次容错」一节):联系人一轮或 Compute 失败后按 kernel retry-policy 决定静默退避重试、出原位失败卡,
// 或被同一上游的共享熔断暂停(全群合并 1 张群级卡);出卡由宿主机械完成,不靠已挂的联系人脑子自报。
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { appendEvent, loadLog, recordAction } from "@g-group/adapter-sqlite";
import type { ComputeAdapter, ComputeEvent } from "@g-group/adapter-cc-compute";
import {
  type ClientInputDraft,
  type CommitmentView,
  type ComputeProgress,
  type ContactView,
  type DraftBody,
  type DraftView,
  type MessageView,
  type ModelChangePreview,
  type ReceiptView,
  type RewindResult,
  type RoomView,
  type SettingsView,
  type TaskView,
  draftIssues,
  draftPreview,
  emptyDraft,
  settleDraft,
} from "@g-group/api-contract";
import {
  type AttemptReason,
  type Ledger,
  type ProjectedMessage,
  type Task,
  type TaskEvent,
  type TaskModelRecord,
  applyLedger,
  apply as applyTask,
  emptyLedger,
  emptyModelRecord,
  isAppendOnly,
  modelConfig,
  newTask,
  producerModels,
  producerVendors,
  project,
  recordAttempt,
} from "@g-group/domain";
import {
  BREAKER_CLOSED,
  type BreakerPolicy,
  type BreakerState,
  type AttentionLoop,
  type ContactCompactor,
  type ContactMind,
  DEFAULT_BREAKER_POLICY,
  DEFAULT_RETRY_POLICY,
  type FailureClass,
  type HealClass,
  type Inbound,
  type InboundMessage,
  type MindAction,
  type RetryPolicy,
  type RoundOutput,
  type RoundStatus,
  type TimerApi,
  type RecallItem,
  type RecallRef,
  type RecallSource,
  type Urgency,
  breakerAdmit,
  breakerFailure,
  breakerSuccess,
  checkRetryPolicy,
  claimFailureCard,
  classifyFailure,
  crashRecover,
  createAttentionLoop,
  planRecall,
  decideRetry,
  effectOf,
  healOf,
  skipTarget,
  compactMaterial,
  scrubRetracted,
} from "@g-group/kernel";
import { type AnnouncementOrder, AnnouncementStore } from "./announcements.ts";
import {
  CONTACT_SYSTEM,
  CONTACT_TOOLS,
  type LedgerLine,
  RECALL_BUDGET_BYTES,
  RECALL_MIN_SLICE_BYTES,
  ROUND_BUDGET_BYTES,
  type RoundAssembler,
  RoundAssembleError,
  kernelAssemble,
} from "./assemble.ts";
import { type Bus, createBus } from "./bus.ts";
import { type Db, HostError, all, getDoc, listDocs, one, openDb, putDoc, run, tx } from "./db.ts";
import { EXIT_SETTLED, LEAVING_REASON, MemberExits } from "./members.ts";
import { CapabilityLibrary } from "./capabilities.ts";
import { PluginStore } from "./plugins.ts";
import { type RewindPlan, inRanges, isRewound, planRewind, rewindNotice, rewindRanges } from "./rewind.ts";
import { QuotaTable } from "./quota.ts";
import { Scheduler, checkCron } from "./schedules.ts";
import { type SearchPage, type SearchQuery, ensureSearchIndex, indexMessageTx, reindexEditTx, searchMessages, unindexTx } from "./search.ts";
import { SharedDocs } from "./shared-docs.ts";
import { type CodeRepoConfig, type Workspace, Worktrees } from "./worktree.ts";
import { type ArtifactRef, ArtifactStore, MAX_ARTIFACT_BYTES, MAX_ARTIFACTS, MAX_INLINE_TEXT, isReadable, recentReadable } from "./artifacts.ts";

export interface HostOptions {
  readonly file: string;
  readonly userId?: string;
  readonly userName?: string;
  /** 每位联系人的脑子;同一个实现可服务多位联系人(round 输入里带联系人档案)。 */
  readonly mind: (contact: ContactView) => ContactMind;
  /** 按模型取 Compute 适配器;不给则派活直接失败(任务进 T11 并告诉联系人)。 */
  readonly compute?: (model: string) => ComputeAdapter;
  /** Compute 工作目录。 */
  readonly computeCwd?: (taskId: string) => string;
  /** 代码仓(AC-22):给了就每个任务一个独立 git worktree 作 Compute 工作目录(优先于 computeCwd),
   *  交付钉住候选提交,用户验收后受控合入目标分支;合入成功才算验收。 */
  readonly codeRepo?: CodeRepoConfig;
  /** 派给 Compute 的内置工具白名单;默认 Read/Write/Edit/Glob/Grep/Bash。 */
  readonly computeTools?: readonly string[];
  readonly assemble?: RoundAssembler;
  /** 整轮五块字节预算(默认 ROUND_BUDGET_BYTES);数值待决(需求文档 v3.20 §8.1 待决 13)。 */
  readonly roundBudgetBytes?: number;
  /** 单轮回读预算 max_recall(默认 RECALL_BUDGET_BYTES)与每条引用保底切片(默认 RECALL_MIN_SLICE_BYTES);数值待决。 */
  readonly recallBudgetBytes?: number;
  readonly recallMinSliceBytes?: number;
  readonly now?: () => string;
  /** 宿主数据目录(插件包装在这里);默认数据库文件所在目录。 */
  readonly dataDir?: string;
  /** 插件市场目录文件 catalog.json;不给就是空市场。 */
  readonly catalogFile?: string | null;
  /** 定时用的时钟(毫秒);默认 Date.now。 */
  readonly clockMs?: () => number;
  readonly newId?: (prefix: string) => string;
  readonly maxDeferMs?: number;
  /** 状态笔记压缩器(D06 第 2 小节第 3 块、D25 第 8 节):按联系人取,必须用它的说话模型做独立调用(AC-32 ③)。不给就不压缩。 */
  readonly compactor?: (contact: ContactView) => ContactCompactor;
  /** 状态笔记的 UTF-8 字节上限;超了请压缩器缩写,仍超就保留并报告,不截断。null / 不给:不设上限。 */
  readonly stateNoteMaxBytes?: number | null;
  readonly timers?: TimerApi;
  readonly onReport?: (what: string, detail: unknown) => void;
  /** 群公告排序(列表与装配共用);默认按创建先后。排序规则待定(D28 待确认 ④),先做成参数。 */
  readonly announcementOrder?: AnnouncementOrder;
  /** 联系人没单独设时的个人 Compute 槽位数(AC-23);不给为不限 */
  readonly personalComputeSlots?: number;
  /** AC-36 静默退避参数(默认值是占位,验收文档第 9 节 F8 待定)。 */
  readonly retry?: Partial<RetryPolicy>;
  /** AC-36 共享上游熔断参数(默认值是占位,第 9 节 F10 待定)。 */
  readonly breaker?: Partial<BreakerPolicy>;
  /** 同一输入允许的启动回收次数(crash_recovery_count 上限,F12),默认 1。 */
  readonly maxCrashRecoveries?: number;
  /** Compute 的 CLI 自己对 API 错误重试的次数(start.ts 经 CLAUDE_CODE_MAX_RETRIES 交给 CLI),与宿主共用同一预算(F3),默认 0。 */
  readonly computeHarnessRetries?: number;
  /** 上游键:同一个键的联系人与 Compute 共享熔断;默认按模型 id。 */
  readonly upstreamOf?: (model: string) => string;
  /** 退避抖动用的随机数,默认 Math.random。 */
  readonly random?: () => number;
}

/** 状态笔记含撤回原文且无法精确移除时,整份作废后的占位(撤回优先,AC-08) */
const VOIDED_NOTE = "(状态笔记含已撤回内容,已作废;请按承诺账本与新消息重写)";

interface ContactDoc extends Omit<ContactView, "activity"> {
  readonly persona: string;
}
interface TaskDoc {
  readonly task: Task;
  readonly title: string;
  readonly roomId: string;
  readonly sourceSeq: number;
  readonly brief: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly result: string | null;
  /** 用户手动新建时填的描述,原样保留(AC-47)。 */
  readonly description?: string;
  /** 交付消息的 seq(AC-56:交付是普通消息);用户的验收结论只认这之后的消息。旧数据没有这个字段。 */
  readonly deliveredSeq?: number | null;
  /** 不可变启动快照 + 只追加尝试账本(AC-32 ④、AC-51 ⑥);旧数据没有这个字段。 */
  readonly models?: TaskModelRecord;
  /** 最近一次交付带回的工件快照(AC-04) */
  readonly artifacts?: readonly ArtifactRef[];
}
interface CardRow {
  card_id: string;
  room_id: string;
  seq: number;
  kind: string;
  task_id: string | null;
  title: string;
  body: string;
  state: string;
  actions: string;
  meta: string;
}
interface MsgMeta {
  thread_root: number | null;
  reply_to: number | null;
  quoted: string;
  mentions: string;
  attachments: string;
  command: string | null;
  card_id: string | null;
  client_action_id: string | null;
}
interface RoomRow {
  id: string;
  kind: "dm" | "group";
  title: string;
  rules: string;
  rules_version: number;
  pinned: number;
  muted: number;
  dm_contact: string | null;
  created_at: string;
  updated_at: string;
}
type Member = { kind: "user" | "contact"; id: string };
type Activity = ContactView["activity"];

export interface SendInput {
  roomId: string;
  clientActionId: string;
  text: string;
  threadRootSeq?: number | null;
  replyToSeq?: number | null;
  quotedSeqs?: number[];
  mentions?: { id: string; source: "auto" | "manual" }[];
  command?: { name: string; args: unknown };
  attachments?: string[];
  /** 发送时输入框草稿的版本(AC-24);成功后只清这一版草稿。 */
  draftVer?: number;
}

const DEFAULT_SETTINGS: SettingsView = {
  defaultHarness: "claude-code",
  defaultSpeakingModel: "claude-sonnet-4-6",
  defaultComputeModel: "claude-sonnet-4-6",
  defaultEffort: "medium",
  timezone: "Asia/Shanghai",
  models: [],
};
const MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".pdf": "application/pdf", ".txt": "text/plain", ".md": "text/markdown", ".json": "application/json", ".csv": "text/csv", ".zip": "application/zip" };
export const DEFAULT_COMPUTE_TOOLS: readonly string[] = Object.freeze(["Read", "Write", "Edit", "Glob", "Grep", "Bash"]);
const TERMINAL: ReadonlySet<string> = new Set(["T8_Accepted", "T10_Cancelled", "T11_Failed"]);

export class Host {
  readonly db: Db;
  readonly bus: Bus;
  readonly userId: string;
  readonly userName: string;
  readonly loop: AttentionLoop;
  readonly scheduler: Scheduler;
  readonly plugins: PluginStore;
  readonly announcements: AnnouncementStore;
  private readonly exits: MemberExits;
  /** 共享文档单一提交点(AC-21):所有写入只经它 */
  readonly docs: SharedDocs;
  readonly worktrees: Worktrees | null;
  readonly artifacts: ArtifactStore;
  /** 全局能力库与联系人专属运行目录(AC-29) */
  readonly capabilities: CapabilityLibrary;
  /** Compute 槽位租约(AC-23):个人槽位 + 本群临时槽位,确认停下才归还 */
  readonly quota: QuotaTable;
  /** 等槽位的启动/续接:槽位空出来按先来先到执行 */
  private readonly pendingLaunch = new Map<string, HostEffect>();
  /** 每个任务第几次起 CLI(启动或续接);某一轮的收尾只在它仍是最新一轮时归还槽位 */
  private readonly launchEpoch = new Map<string, number>();
  /** 停止没确认下来的原因(进程没退干净),任务视图里显示 */
  private readonly stopUnconfirmed = new Map<string, string>();
  private readonly opts: HostOptions;
  private readonly now: () => string;
  private readonly newId: (prefix: string) => string;
  private readonly assemble: RoundAssembler;
  private readonly activity = new Map<string, Activity>();
  private readonly adapters = new Map<string, ComputeAdapter>();
  private readonly pumps: Promise<void>[] = [];
  private roundNo = 0;
  private closed = false;
  /** 本次启动编号:在途轮次标记里写它,重启后据此认出上次留下的未提交轮次(F12)。 */
  private readonly bootId: string;
  private readonly retryPolicy: RetryPolicy;
  private readonly breakerPolicy: BreakerPolicy;
  private readonly timersApi: TimerApi;
  private readonly clock: () => number;
  /** 宿主自己的计时器:Compute 续跑退避、熔断半开探测。关闭时全部清掉。 */
  private readonly hostTimers = new Map<string, unknown>();
  /** 用户在群级卡上点了[重试]、下一次放行按用户发起的探测处理的上游。 */
  private readonly manualProbe = new Set<string>();
  private readonly random: () => number;

  constructor(opts: HostOptions) {
    this.opts = opts;
    this.now = opts.now ?? (() => new Date().toISOString());
    let n = 0;
    this.newId = opts.newId ?? ((p) => `${p}-${Date.now().toString(36)}-${(n++).toString(36)}`);
    this.assemble = opts.assemble ?? kernelAssemble;
    this.userId = opts.userId ?? "me";
    this.userName = opts.userName ?? "我";
    this.db = openDb(opts.file);
    this.exits = new MemberExits({ db: this.db, now: this.now });
    // 搜索索引是派生物:表缺失或版本不符就从只追加日志重建(AC-25)
    ensureSearchIndex(this.db);
    this.bus = createBus(this.now);
    this.bootId = this.newId("boot");
    const policy = checkRetryPolicy({ ...DEFAULT_RETRY_POLICY, ...(opts.retry ?? {}) });
    if (!policy.ok) throw new HostError("invalid_params", `重试参数不合格:${policy.reason}`);
    this.retryPolicy = policy.policy;
    this.breakerPolicy = { ...DEFAULT_BREAKER_POLICY, ...(opts.breaker ?? {}) };
    this.clock = opts.clockMs ?? Date.now;
    this.random = opts.random ?? Math.random;
    this.loop = createAttentionLoop({
      maxDeferMs: opts.maxDeferMs ?? 1500,
      ...(opts.timers ? { timers: opts.timers } : {}),
      run: (id, signal) => this.runRound(id, signal),
      // 联系人一轮失败后多久重跑由失败策略定(AC-36):RoundRetry 带退避延迟;已出卡或被熔断暂停的一轮不抛错。其余(宿主自身出错)按 1 秒兜底
      retryAfter: (_id, e) => (e instanceof RoundRetry ? e.delayMs : 1000),
      onReport: (id, what, detail) => this.report(`attention:${what}:${id}`, detail),
    });
    const timers: TimerApi = opts.timers ?? { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) };
    this.timersApi = timers;
    this.scheduler = new Scheduler({
      db: this.db,
      clockMs: opts.clockMs ?? Date.now,
      timers,
      newId: this.newId,
      checkMember: (contactId, roomId) => {
        this.contactDoc(contactId);
        this.roomRow(roomId);
        if (!this.isMember(roomId, { kind: "contact", id: contactId })) throw new HostError("forbidden", "联系人不在这个会话里");
      },
      deliverTx: (contactId, roomId, inbound) => {
        run(this.db, "INSERT INTO gg_inbox (contact_id, room_id, payload, at) VALUES (?, ?, ?, ?)", contactId, roomId, JSON.stringify(inbound), this.now());
      },
      notify: (contactId) => this.loop.notify(contactId, "now"),
      label: (contactId, roomId) => {
        const c = getDoc<ContactDoc>(this.db, `contact:${contactId}`)?.value;
        const r = one<{ title: string }>(this.db, "SELECT title FROM gg_rooms WHERE id = ?", roomId);
        return { ...(r ? { roomTitle: r.title } : {}), ...(c ? { contactName: c.name } : {}) };
      },
      emit: (s) => {
        if ("removed" in s) this.bus.emit({ type: "schedule.removed", scheduleId: s.removed });
        else this.bus.emit({ type: "schedule.updated", schedule: s });
      },
    });
    this.capabilities = new CapabilityLibrary(opts.dataDir ?? dirname(opts.file));
    this.quota = new QuotaTable({
      personal: (contactId) => getDoc<ContactDoc>(this.db, `contact:${contactId}`)?.value.computeSlots ?? opts.personalComputeSlots ?? Number.POSITIVE_INFINITY,
      group: (roomId) => getDoc<{ slots: number }>(this.db, `room-slots:${roomId}`)?.value.slots ?? 0,
      newId: () => this.newId("l"),
    });
    this.plugins = new PluginStore({
      db: this.db,
      dataDir: opts.dataDir ?? dirname(opts.file),
      catalogFile: opts.catalogFile ?? null,
      now: this.now,
      emit: (v) => {
        if ("removed" in v) this.bus.emit({ type: "plugin.removed", pluginId: v.removed });
        else this.bus.emit({ type: "plugin.updated", plugin: v });
      },
      commandsChanged: () => this.bus.emit({ type: "commands.changed", roomId: null, commands: null }),
    });
    this.announcements = new AnnouncementStore({
      db: this.db,
      now: this.now,
      newId: this.newId,
      order: opts.announcementOrder ?? "created-asc",
      roomKind: (roomId) => this.roomRow(roomId).kind,
      changed: (roomId) => this.bus.emit({ type: "room.updated", room: this.roomView(roomId) }),
    });
    this.docs = new SharedDocs({
      db: this.db,
      dataDir: opts.dataDir ?? dirname(opts.file),
      now: this.now,
      newId: this.newId,
      checkRoom: (roomId) => void this.roomRow(roomId),
      emit: (doc) => this.bus.emit({ type: "doc.updated", doc }),
      onReport: (what, detail) => this.report(what, detail),
    });
    // 启动时派生镜像按权威版本修复(中断的导出、迟到的旧内容覆盖)
    this.docs.repairMirrors();
    this.worktrees = opts.codeRepo ? new Worktrees(opts.codeRepo, join(opts.dataDir ?? dirname(opts.file), "worktrees")) : null;
    this.artifacts = new ArtifactStore(this.db, join(opts.dataDir ?? dirname(opts.file), "artifacts"), this.now);
    // 启动时先处理宿主关着期间到期的定时(按容差与 missedPolicy),再按最早一次设计时器
    this.scheduler.tick();
    // 启动回收(F4/F6/F12):上次留下的未提交轮次按 crash_recovery_count 决定续跑或熔断出卡;磁盘上还没被领走的输入交给联系人
    this.reconcileOnStart();
  }

  private report(what: string, detail: unknown) {
    try {
      this.opts.onReport?.(what, detail);
    } catch {
      /* 报告回调出错不影响宿主 */
    }
  }

  // ======================= 联系人 =======================
  createContact(input: { clientActionId?: string; name: string; bio?: string; speakingModel?: string; harness?: ContactView["harness"]; computeModel?: ContactView["computeModel"]; persona?: string; confirmAffected?: boolean }): ContactView {
    const id = this.newId("c");
    const settings = this.settings();
    const doc: ContactDoc = {
      id,
      name: input.name,
      avatar: null,
      bio: input.bio ?? "",
      speakingModel: input.speakingModel ?? settings.defaultSpeakingModel,
      harness: input.harness ?? settings.defaultHarness,
      computeModel: input.computeModel ?? { mode: "inherit" },
      tools: [],
      computeAssets: [],
      createdAt: this.now(),
      persona: input.persona ?? "",
    };
    // 保存时机(AC-32 ②①):新联系人自己的 Compute 生效值不兼容就先拦,看过预览确认后才存
    this.guardModelChange(modelConfig.previewChange(this.modelDefaults(), [this.contactModels(doc)], this.caps(), { kind: "contact", contactId: id, patch: {} }), input.confirmAffected === true);
    putDoc(this.db, `contact:${id}`, 0, doc);
    const view = this.contactView(doc);
    this.bus.emit({ type: "contact.updated", contact: view });
    return view;
  }
  updateContact(id: string, input: Partial<Omit<ContactDoc, "id" | "createdAt">> & { confirmAffected?: boolean }): ContactView {
    const { confirmAffected, ...patch } = input;
    const cur = this.contactDoc(id);
    const next: ContactDoc = { ...cur.value, ...patch, id, createdAt: cur.value.createdAt };
    if (patch.speakingModel !== undefined || patch.harness !== undefined || patch.computeModel !== undefined) {
      const change: modelConfig.ModelChange = {
        kind: "contact",
        contactId: id,
        patch: { speakingModel: next.speakingModel, harness: next.harness, computeModel: next.computeModel },
      };
      this.guardModelChange(modelConfig.previewChange(this.modelDefaults(), this.liveContacts().map((c) => this.contactModels(c)), this.caps(), change), confirmAffected === true);
    }
    putDoc(this.db, `contact:${id}`, cur.ver, next);
    const view = this.contactView(next);
    this.bus.emit({ type: "contact.updated", contact: view });
    return view;
  }
  contactDoc(id: string): { value: ContactDoc; ver: number } {
    const d = getDoc<ContactDoc>(this.db, `contact:${id}`);
    if (!d) throw new HostError("not_found", `没有联系人 ${id}`);
    return d;
  }
  contactView(doc: ContactDoc): ContactView {
    const { persona: _p, removed: _r, computeResolved: _cr, ...rest } = doc as ContactDoc & { removed?: boolean };
    const resolved = this.resolveComputeFor(doc);
    return {
      ...rest,
      activity: this.activity.get(doc.id) ?? "idle",
      computeResolved: { resolved: resolvedView(resolved), support: modelConfig.supportOf(this.caps(), resolved.harness, resolved.model) },
    };
  }
  private liveContacts(): ContactDoc[] {
    return listDocs<ContactDoc & { removed?: boolean }>(this.db, "contact:")
      .filter((d) => !d.value.removed)
      .map((d) => d.value);
  }
  listContacts(): ContactView[] {
    return this.liveContacts().map((d) => this.contactView(d));
  }
  private setActivity(contactId: string, roomId: string | null, a: Activity) {
    if (this.activity.get(contactId) === a) return;
    this.activity.set(contactId, a);
    this.bus.emit({ type: "contact.activity", contactId, roomId, activity: a });
  }

  // ======================= 设置 =======================
  settings(): SettingsView {
    return getDoc<SettingsView>(this.db, "settings")?.value ?? DEFAULT_SETTINGS;
  }
  updateSettings(input: Partial<SettingsView> & { confirmAffected?: boolean }): SettingsView {
    const { confirmAffected, ...patch } = input;
    const cur = getDoc<SettingsView>(this.db, "settings");
    const next = { ...(cur?.value ?? DEFAULT_SETTINGS), ...patch };
    // 上游改动(AC-32 ②):全局默认或能力声明变了,保存前按新值预检全部下游联系人
    if (patch.defaultHarness !== undefined || patch.defaultSpeakingModel !== undefined || patch.defaultComputeModel !== undefined || patch.defaultEffort !== undefined || patch.models !== undefined) {
      const change: modelConfig.ModelChange = { kind: "defaults", patch: defaultsOf(next) };
      this.guardModelChange(modelConfig.previewChange(this.modelDefaults(), this.liveContacts().map((c) => this.contactModels(c)), capsOf(next), change), confirmAffected === true);
    }
    putDoc(this.db, "settings", cur?.ver ?? 0, next);
    return next;
  }
  // ======================= 模型配置(AC-32) =======================
  modelDefaults(): modelConfig.ModelDefaults {
    return defaultsOf(this.settings());
  }
  private caps(): modelConfig.ModelCapability[] {
    return capsOf(this.settings());
  }
  private contactModels(c: ContactDoc): modelConfig.ContactModels {
    return { id: c.id, name: c.name, speakingModel: c.speakingModel, harness: c.harness, computeModel: c.computeModel };
  }
  /** 这位联系人 Compute 此刻的生效值:每次现场解析,不复用启动时的值(U93)。 */
  resolveComputeFor(c: ContactDoc, override?: modelConfig.TaskModelOverride): modelConfig.ResolvedCompute {
    return modelConfig.resolveCompute(this.modelDefaults(), this.contactModels(c), override);
  }
  /** 预检有冲突且没确认:拒绝保存,错误里带完整预览(两条修复路径在每位冲突联系人的 fixes 里)。 */
  private guardModelChange(out: modelConfig.ChangeOutcome, confirmed: boolean) {
    const conflicts = out.preview.conflicts;
    if (conflicts.length === 0 || confirmed) return;
    throw new HostError("conflict", incompatibleMessage(conflicts), {
      reason: "model-incompatible",
      preview: previewView(out.preview),
    });
  }
  private planModelChange(change: ModelChangeInput): modelConfig.ChangeOutcome {
    const contacts = this.liveContacts();
    let c: modelConfig.ModelChange;
    if (change.kind === "defaults") {
      const patch: Partial<modelConfig.ModelDefaults> = {
        ...(change.defaultHarness !== undefined ? { harness: change.defaultHarness } : {}),
        ...(change.defaultSpeakingModel !== undefined ? { speakingModel: change.defaultSpeakingModel } : {}),
        ...(change.defaultComputeModel !== undefined ? { computeModel: change.defaultComputeModel } : {}),
        ...(change.defaultEffort !== undefined ? { effort: change.defaultEffort } : {}),
      };
      c = { kind: "defaults", patch };
    } else if (change.kind === "contact") {
      if (!contacts.some((x) => x.id === change.contactId)) throw new HostError("not_found", `没有联系人 ${change.contactId}`);
      c = {
        kind: "contact",
        contactId: change.contactId,
        patch: {
          ...(change.speakingModel !== undefined ? { speakingModel: change.speakingModel } : {}),
          ...(change.harness !== undefined ? { harness: change.harness } : {}),
          ...(change.computeModel !== undefined ? { computeModel: change.computeModel } : {}),
        },
      };
    } else c = { kind: "batch-replace", from: change.from, to: change.to };
    return modelConfig.previewChange(this.modelDefaults(), contacts.map((x) => this.contactModels(x)), this.caps(), c);
  }
  /** 保存前预检:不落盘。 */
  previewModelChange(change: ModelChangeInput): ModelChangePreview {
    return previewView(this.planModelChange(change).preview);
  }
  /** 把模型 X 批量换成 Y(规则 6):apply 不为 true 只预览;应用只改全局默认与显式写了 X 的联系人,在途与历史任务的模型记录不碰。 */
  batchReplaceModels(from: string, to: string, o: { apply?: boolean; confirmAffected?: boolean } = {}): { applied: boolean; preview: ModelChangePreview } {
    const out = this.planModelChange({ kind: "batch-replace", from, to });
    const preview = previewView(out.preview);
    if (o.apply !== true) return { applied: false, preview };
    this.guardModelChange(out, o.confirmAffected === true);
    const changedIds = new Set(out.preview.affected.filter((a) => a.involvement === "explicit-reference").map((a) => a.contactId));
    const touched: ContactDoc[] = [];
    tx(this.db, () => {
      const cur = getDoc<SettingsView>(this.db, "settings");
      const base = cur?.value ?? DEFAULT_SETTINGS;
      putDoc(this.db, "settings", cur?.ver ?? 0, { ...base, defaultSpeakingModel: out.defaults.speakingModel, defaultComputeModel: out.defaults.computeModel });
      for (const m of out.contacts) {
        if (!changedIds.has(m.id)) continue;
        const d = this.contactDoc(m.id);
        const next: ContactDoc = { ...d.value, speakingModel: m.speakingModel, computeModel: m.computeModel as ContactDoc["computeModel"] };
        putDoc(this.db, `contact:${m.id}`, d.ver, next);
        touched.push(next);
      }
    });
    for (const c of touched) this.bus.emit({ type: "contact.updated", contact: this.contactView(c) });
    return { applied: true, preview };
  }
  computeModelOf(c: ContactDoc): string {
    return this.resolveComputeFor(c).model;
  }

  // ======================= 会话 =======================
  private roomRow(id: string): RoomRow {
    const r = one<RoomRow>(this.db, "SELECT * FROM gg_rooms WHERE id = ?", id);
    if (!r) throw new HostError("not_found", `没有会话 ${id}`);
    return r;
  }
  members(roomId: string): Member[] {
    return all<{ kind: Member["kind"]; member_id: string }>(this.db, "SELECT kind, member_id FROM gg_members WHERE room_id = ? ORDER BY kind, member_id", roomId).map((m) => ({
      kind: m.kind,
      id: m.member_id,
    }));
  }
  private isMember(roomId: string, m: Member): boolean {
    return !!one(this.db, "SELECT 1 FROM gg_members WHERE room_id = ? AND kind = ? AND member_id = ?", roomId, m.kind, m.id);
  }
  openDm(contactId: string): RoomView {
    const c = this.contactDoc(contactId).value;
    const existing = one<{ id: string }>(this.db, "SELECT id FROM gg_rooms WHERE dm_contact = ?", contactId);
    if (existing) return this.roomView(existing.id);
    const id = `dm-${contactId}`;
    const at = this.now();
    tx(this.db, () => {
      run(this.db, "INSERT INTO gg_rooms (id, kind, title, dm_contact, created_at, updated_at) VALUES (?, 'dm', ?, ?, ?, ?)", id, c.name, contactId, at, at);
      run(this.db, "INSERT INTO gg_members (room_id, kind, member_id) VALUES (?, 'user', ?), (?, 'contact', ?)", id, this.userId, id, contactId);
    });
    const view = this.roomView(id);
    this.bus.emit({ type: "room.updated", room: view });
    return view;
  }
  createGroup(title: string, members: Member[]): RoomView {
    for (const m of members) if (m.kind === "contact") this.contactDoc(m.id);
    const id = this.newId("g");
    const at = this.now();
    const all_: Member[] = [{ kind: "user", id: this.userId }, ...members.filter((m) => !(m.kind === "user" && m.id === this.userId))];
    tx(this.db, () => {
      run(this.db, "INSERT INTO gg_rooms (id, kind, title, created_at, updated_at) VALUES (?, 'group', ?, ?, ?)", id, title, at, at);
      for (const m of all_) run(this.db, "INSERT OR IGNORE INTO gg_members (room_id, kind, member_id) VALUES (?, ?, ?)", id, m.kind, m.id);
    });
    const view = this.roomView(id);
    this.bus.emit({ type: "room.updated", room: view });
    return view;
  }
  addMembers(roomId: string, members: Member[]): RoomView {
    const r = this.roomRow(roomId);
    if (r.kind === "dm") throw new HostError("forbidden", "私聊不能加成员,请建群");
    for (const m of members) if (m.kind === "contact") this.contactDoc(m.id);
    const leaving = members.filter((m) => m.kind === "contact" && this.exits.isLeaving(roomId, m.id));
    if (leaving.length) throw new HostError("conflict", "联系人正在移出这个群,等它在这里的在途任务停下再拉回", { leaving: leaving.map((m) => m.id) });
    tx(this.db, () => {
      // 真正新入群的联系人(含移出后又拉回的)游标从当前末尾开始:不追溯处理入群前与离开期间的消息(AC-49);
      // 已在群里的重复拉入什么都不动,不挪它的游标
      const last = this.lastSeq(roomId);
      for (const m of members) {
        const added = run(this.db, "INSERT OR IGNORE INTO gg_members (room_id, kind, member_id) VALUES (?, ?, ?)", roomId, m.kind, m.id) === 1;
        if (added && m.kind === "contact") {
          run(this.db, "INSERT INTO gg_cursor (contact_id, room_id, processed_seq) VALUES (?, ?, ?) ON CONFLICT (contact_id, room_id) DO UPDATE SET processed_seq = excluded.processed_seq", m.id, roomId, last);
        }
      }
    });
    const view = this.roomView(roomId);
    this.bus.emit({ type: "room.updated", room: view });
    return view;
  }
  updateRoom(roomId: string, patch: { title?: string; pinned?: boolean; muted?: boolean; rules?: string; expectedRulesVersion?: number; tempComputeSlots?: number }): RoomView {
    const r = this.roomRow(roomId);
    if (patch.tempComputeSlots !== undefined) {
      if (r.kind !== "group") throw new HostError("invalid_params", "私聊没有群临时 Compute 槽位");
      const cur = getDoc<{ slots: number }>(this.db, `room-slots:${roomId}`);
      putDoc(this.db, `room-slots:${roomId}`, cur?.ver ?? 0, { slots: patch.tempComputeSlots });
    }
    if (patch.rules !== undefined && patch.expectedRulesVersion !== undefined && patch.expectedRulesVersion !== r.rules_version) {
      throw new HostError("conflict", "群规已被别人改过", { currentVer: r.rules_version });
    }
    run(
      this.db,
      "UPDATE gg_rooms SET title = ?, pinned = ?, muted = ?, rules = ?, rules_version = ?, updated_at = ? WHERE id = ?",
      patch.title ?? r.title,
      patch.pinned === undefined ? r.pinned : Number(patch.pinned),
      patch.muted === undefined ? r.muted : Number(patch.muted),
      patch.rules ?? r.rules,
      patch.rules !== undefined && patch.rules !== r.rules ? r.rules_version + 1 : r.rules_version,
      this.now(),
      roomId,
    );
    const view = this.roomView(roomId);
    this.bus.emit({ type: "room.updated", room: view });
    return view;
  }
  roomsOfUser(): RoomView[] {
    return all<{ room_id: string }>(this.db, "SELECT room_id FROM gg_members WHERE kind = 'user' AND member_id = ?", this.userId)
      .map((r) => this.roomView(r.room_id))
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || (a.updatedAt < b.updatedAt ? 1 : -1));
  }
  roomsOfContact(contactId: string): RoomRow[] {
    return all<RoomRow>(this.db, "SELECT r.* FROM gg_rooms r JOIN gg_members m ON m.room_id = r.id WHERE m.kind = 'contact' AND m.member_id = ? ORDER BY r.id", contactId);
  }
  lastSeq(roomId: string): number {
    return one<{ s: number | null }>(this.db, "SELECT max(seq) AS s FROM events WHERE session = ?", `room:${roomId}`)?.s ?? 0;
  }
  readSeq(roomId: string, m: Member): number {
    return one<{ s: number | null }>(this.db, "SELECT max(upto_seq) AS s FROM gg_read WHERE room_id = ? AND kind = ? AND member_id = ?", roomId, m.kind, m.id)?.s ?? 0;
  }
  roomView(roomId: string): RoomView {
    const r = this.roomRow(roomId);
    const msgs = this.projected(roomId);
    const readSeq = this.readSeq(roomId, { kind: "user", id: this.userId });
    const visible = msgs.filter((m) => !m.retracted);
    const last = visible.at(-1);
    const openCards = one<{ n: number }>(this.db, "SELECT count(*) AS n FROM gg_cards WHERE room_id = ? AND state = 'open'", roomId)?.n ?? 0;
    // 等用户回复的交付(普通消息交付,没有卡片)也算一件待你处理的事
    const pending = openCards + listDocs<TaskDoc>(this.db, "task:").filter((d) => d.value.roomId === roomId && awaitingUser(d.value)).length;
    const draft = getDoc<DraftView>(this.db, `draft:${roomId}`)?.value;
    return {
      id: r.id,
      kind: r.kind,
      title: r.title,
      avatar: null,
      members: this.members(roomId),
      rules: r.rules,
      rulesVersion: r.rules_version,
      pinned: !!r.pinned,
      muted: !!r.muted,
      lastSeq: this.lastSeq(roomId),
      readSeq,
      unread: visible.filter((m) => m.seq > readSeq && !(m.sender.kind === "user" && m.sender.id === this.userId)).length,
      pendingForUser: pending,
      lastMessagePreview: last ? last.text.slice(0, 200) : null,
      ...(draft ? { draftPreview: draftPreview(draft) } : {}),
      updatedAt: r.updated_at,
      announcementCount: r.kind === "group" ? this.announcements.count(roomId) : 0,
      leavingMembers: this.exits.leavingIn(roomId),
      ...(r.kind === "group" ? { tempComputeSlots: getDoc<{ slots: number }>(this.db, `room-slots:${roomId}`)?.value.slots ?? 0 } : {}),
    };
  }
  markRead(roomId: string, m: Member, seq: number) {
    const cur = this.readSeq(roomId, m);
    const upto = Math.min(seq, this.lastSeq(roomId));
    if (upto <= cur) return;
    run(this.db, "INSERT INTO gg_read (room_id, kind, member_id, upto_seq, at) VALUES (?, ?, ?, ?, ?)", roomId, m.kind, m.id, upto, this.now());
    this.bus.emit({ type: "receipt.updated", roomId, member: m, readSeq: upto });
  }

  // ======================= 消息 =======================
  projected(roomId: string): ProjectedMessage[] {
    const { log, check } = loadLog(this.db.store, `room:${roomId}`);
    if (!check.ok) this.report("log-broken", { roomId, at: check.brokenAt });
    return project(log);
  }
  private nameOf(s: { kind: string; id: string }): string {
    if (s.kind === "user") return s.id === this.userId ? this.userName : s.id;
    if (s.kind === "contact") return getDoc<ContactDoc>(this.db, `contact:${s.id}`)?.value.name ?? s.id;
    return "宿主";
  }
  messageView(roomId: string, m: ProjectedMessage, all_?: ProjectedMessage[]): MessageView {
    const meta = one<MsgMeta>(this.db, "SELECT * FROM gg_msg WHERE room_id = ? AND seq = ?", roomId, m.seq);
    const quoted: number[] = meta ? (JSON.parse(meta.quoted) as number[]) : [];
    const list = all_ ?? (quoted.length ? this.projected(roomId) : []);
    const card = meta?.card_id ? one<CardRow>(this.db, "SELECT * FROM gg_cards WHERE card_id = ?", meta.card_id) : undefined;
    const reactions = new Map<string, Member[]>();
    for (const r of all<{ emoji: string; kind: Member["kind"]; member_id: string }>(this.db, "SELECT emoji, kind, member_id FROM gg_reactions WHERE room_id = ? AND seq = ? ORDER BY rowid", roomId, m.seq)) {
      reactions.set(r.emoji, [...(reactions.get(r.emoji) ?? []), { kind: r.kind, id: r.member_id }]);
    }
    return {
      roomId,
      seq: m.seq,
      threadRootSeq: meta?.thread_root ?? null,
      sender: { kind: m.sender.kind, id: m.sender.id },
      text: m.retracted ? "" : m.text,
      mentions: meta ? (JSON.parse(meta.mentions) as MessageView["mentions"]) : [],
      replyToSeq: meta?.reply_to ?? null,
      quotedSeqs: quoted,
      quotes: quoted.map((q) => {
        const src = list.find((x) => x.seq === q);
        return { seq: q, senderName: src ? this.nameOf(src.sender) : "?", excerpt: src && !src.retracted ? src.text.slice(0, 200) : "", state: !src ? "denied" : src.retracted ? "retracted" : "ok" };
      }),
      attachments: (meta ? (JSON.parse(meta.attachments) as string[]) : [])
        .map((ref) => one<{ ref: string; name: string; mime: string; bytes: number }>(this.db, "SELECT ref, name, mime, bytes FROM gg_attachments WHERE ref = ?", ref))
        .filter((a): a is { ref: string; name: string; mime: string; bytes: number } => !!a),
      card: card
        ? {
            kind: card.kind as NonNullable<MessageView["card"]>["kind"],
            cardId: card.card_id,
            taskId: card.task_id,
            title: card.title,
            body: card.body,
            state: card.state as NonNullable<MessageView["card"]>["state"],
            actions: JSON.parse(card.actions) as NonNullable<MessageView["card"]>["actions"],
          }
        : null,
      command: meta?.command ? (JSON.parse(meta.command) as MessageView["command"]) : null,
      reactions: [...reactions].map(([emoji, by]) => ({ emoji, by })),
      edited: m.edited,
      retracted: m.retracted,
      clientActionId: meta?.client_action_id ?? null,
      at: one<{ at: string }>(this.db, "SELECT at FROM events WHERE session = ? AND seq = ?", `room:${roomId}`, m.seq)?.at ?? this.now(),
      ...(isRewound(this.db, roomId, m.seq) ? { rewound: true } : {}),
      ...(m.retracted ? {} : this.messageArtifacts(roomId, m.seq)),
    };
  }
  listMessages(roomId: string, q: { beforeSeq?: number; afterSeq?: number; aroundSeq?: number; limit?: number; threadRootSeq?: number | null }): { messages: MessageView[]; hasMore: boolean; hasMoreAfter?: boolean } {
    this.roomRow(roomId);
    if (q.aroundSeq !== undefined && (q.beforeSeq !== undefined || q.afterSeq !== undefined)) throw new HostError("invalid_params", "aroundSeq 不能和 beforeSeq/afterSeq 同时用");
    const msgs = this.projected(roomId);
    let sel = msgs.filter((m) => (q.beforeSeq === undefined || m.seq < q.beforeSeq) && (q.afterSeq === undefined || m.seq > q.afterSeq));
    if (q.threadRootSeq !== undefined) {
      const roots = new Map(all<{ seq: number; thread_root: number | null }>(this.db, "SELECT seq, thread_root FROM gg_msg WHERE room_id = ?", roomId).map((r) => [r.seq, r.thread_root]));
      sel = sel.filter((m) => (roots.get(m.seq) ?? null) === q.threadRootSeq || (q.threadRootSeq !== null && m.seq === q.threadRootSeq));
    }
    const limit = q.limit ?? 100;
    if (q.aroundSeq !== undefined) {
      // 搜索结果跳转:以该条为中心取一页,包含它本身(AC-25)
      const at = sel.findIndex((m) => m.seq === q.aroundSeq);
      if (at < 0) throw new HostError("not_found", `这个会话里没有 #${q.aroundSeq}`);
      const from = Math.max(0, Math.min(at - Math.floor((limit - 1) / 2), sel.length - limit));
      const page = sel.slice(from, from + limit);
      return { messages: page.map((m) => this.messageView(roomId, m, msgs)), hasMore: from > 0, hasMoreAfter: from + page.length < sel.length };
    }
    const hasMore = sel.length > limit;
    const page = q.afterSeq !== undefined ? sel.slice(0, limit) : sel.slice(-limit);
    return { messages: page.map((m) => this.messageView(roomId, m, msgs)), hasMore };
  }

  /** 写一条消息(正文进只追加日志,结构化字段进 gg_msg)。actionKey 相同的重放返回原消息,不重复入库。必须在事务里调用。 */
  private appendMessageTx(
    roomId: string,
    sender: { kind: "user" | "contact" | "helper"; id: string },
    f: { text: string; actionKey: string; clientActionId?: string | null; attachments?: string[]; threadRootSeq?: number | null; replyToSeq?: number | null; quotedSeqs?: number[]; mentions?: MessageView["mentions"]; command?: { name: string; args: unknown } | null; card?: Omit<CardRow, "room_id" | "seq"> | null },
  ): { seq: number; duplicate: boolean } {
    const key = `msg:${roomId}:${f.actionKey}`;
    const prior = one<{ payload: string }>(this.db, "SELECT payload FROM actions WHERE action_id = ?", key);
    if (prior) return { seq: (JSON.parse(prior.payload) as { seq: number }).seq, duplicate: true };
    const at = this.now();
    const e = appendEvent(this.db.store, `room:${roomId}`, sender, { kind: "message", text: f.text }, at);
    recordAction(this.db.store, key, { seq: e.seq });
    indexMessageTx(this.db, { roomId, seq: e.seq, at, sender, threadRoot: f.threadRootSeq ?? null, text: f.text, attachments: f.attachments ?? [] });
    // 回复 = @原作者 + 引用(AC-37 ①):主回复对象一定在引用里;引用保序去重
    const quoted = [...new Set([...(f.quotedSeqs ?? []), ...(f.replyToSeq != null ? [f.replyToSeq] : [])])];
    run(
      this.db,
      "INSERT INTO gg_msg (room_id, seq, thread_root, reply_to, quoted, mentions, attachments, command, card_id, client_action_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      roomId,
      e.seq,
      f.threadRootSeq ?? null,
      f.replyToSeq ?? null,
      JSON.stringify(quoted),
      JSON.stringify(f.mentions ?? []),
      JSON.stringify(f.attachments ?? []),
      f.command ? JSON.stringify(f.command) : null,
      f.card?.card_id ?? null,
      f.clientActionId ?? null,
    );
    if (f.card) {
      run(
        this.db,
        "INSERT INTO gg_cards (card_id, room_id, seq, kind, task_id, title, body, state, actions, meta) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        f.card.card_id,
        roomId,
        e.seq,
        f.card.kind,
        f.card.task_id,
        f.card.title,
        f.card.body,
        f.card.state,
        f.card.actions,
        f.card.meta,
      );
    }
    run(this.db, "UPDATE gg_rooms SET updated_at = ? WHERE id = ?", this.now(), roomId);
    return { seq: e.seq, duplicate: false };
  }

  /** 发完一条消息之后:推事件、送达成员联系人的注意循环。 */
  private afterAppend(roomId: string, seq: number, from: { kind: Member["kind"] | "helper"; id: string }) {
    const msgs = this.projected(roomId);
    const m = msgs.find((x) => x.seq === seq);
    if (!m) return;
    const view = this.messageView(roomId, m, msgs);
    this.bus.emit({ type: "message.appended", message: view });
    this.bus.emit({ type: "room.updated", room: this.roomView(roomId) });
    const room = this.roomRow(roomId);
    const repliedTo = view.replyToSeq !== null ? msgs.find((x) => x.seq === view.replyToSeq) : undefined;
    for (const mem of this.members(roomId)) {
      if (mem.kind !== "contact" || (from.kind === "contact" && from.id === mem.id) || this.exits.isLeaving(roomId, mem.id)) continue;
      // 调度只看元数据(@、私聊、回复对象),不读正文(D15.1)
      const direct = room.kind === "dm" || view.mentions.some((x) => x.id === mem.id) || (repliedTo?.sender.kind === "contact" && repliedTo.sender.id === mem.id);
      const urgency: Urgency = direct && from.kind === "user" ? "now" : "batch";
      this.loop.notify(mem.id, urgency);
    }
  }

  /** Helper 在聊天里的公开回复(AC-52 @Helper):以 helper 发言者写一条消息,回复那条 @ 它的用户消息;clientActionId 幂等。 */
  postAsHelper(roomId: string, helperId: string, text: string, replyToSeq: number, clientActionId: string): MessageView {
    const from = { kind: "helper" as const, id: helperId };
    const r = tx(this.db, () => this.appendMessageTx(roomId, from, { text, actionKey: `helper:${clientActionId}`, clientActionId, replyToSeq, quotedSeqs: [replyToSeq] }));
    if (!r.duplicate) this.afterAppend(roomId, r.seq, from);
    return this.messageView(roomId, this.projected(roomId).find((x) => x.seq === r.seq)!);
  }

  send(input: SendInput): MessageView {
    const room = this.roomRow(input.roomId);
    const me: Member = { kind: "user", id: this.userId };
    if (!this.isMember(room.id, me)) throw new HostError("forbidden", "你不在这个会话里");
    const msgs = this.projected(room.id);
    for (const q of [...(input.quotedSeqs ?? []), ...(input.replyToSeq != null ? [input.replyToSeq] : [])]) {
      if (!msgs.some((m) => m.seq === q)) throw new HostError("invalid_params", `引用的 #${q} 不在这个会话里`);
    }
    if (!input.text.trim() && !input.attachments?.length) throw new HostError("invalid_params", "消息不能为空");
    // 内置 slash 命令(像 Telegram 那样在输入框唤醒能力):先校验,不合格整条不发
    const cmd = this.prepareBuiltin(room, input);
    if (cmd.mention && !(input.mentions ?? []).some((m) => m.id === cmd.mention)) input = { ...input, mentions: [...(input.mentions ?? []), { id: cmd.mention, source: "auto" }] };
    for (const ref of input.attachments ?? []) if (!one(this.db, "SELECT 1 FROM gg_attachments WHERE ref = ?", ref)) throw new HostError("invalid_params", `附件 ${ref} 不存在,请先 attachments.add`);
    const submitted = { text: input.text, replyToSeq: input.replyToSeq ?? null, quotedSeqs: input.quotedSeqs ?? [], mentions: input.mentions ?? [] };
    let settled: DraftView | null = null;
    const r = tx(this.db, () => {
      const appended = this.appendMessageTx(room.id, me, {
        text: input.text.trim() ? input.text : `[附件 ${input.attachments!.length} 个]`,
        attachments: input.attachments ?? [],
        actionKey: `user:${input.clientActionId}`,
        clientActionId: input.clientActionId,
        threadRootSeq: input.threadRootSeq ?? null,
        replyToSeq: input.replyToSeq ?? null,
        quotedSeqs: input.quotedSeqs ?? [],
        mentions: input.mentions ?? [],
        command: input.command ?? null,
      });
      // 发送成功与草稿清理同一事务(AC-24):只清 draftVer 那一版,等回执期间新打的字保留
      if (input.draftVer !== undefined) settled = this.settleDraftTx(room.id, { roomId: room.id, submittedVer: input.draftVer, submitted });
      return appended;
    });
    if (settled) this.bus.emit({ type: "draft.updated", draft: settled });
    if (!r.duplicate) {
      // 自己发的消息自己已读
      this.markRead(room.id, me, r.seq);
      cmd.after?.();
      this.afterAppend(room.id, r.seq, me);
    }
    const m = this.projected(room.id).find((x) => x.seq === r.seq)!;
    return this.messageView(room.id, m);
  }

  /**
   * 内置命令:/task 把活交给某位联系人(自动 @ 它);/remind 让联系人按 cron 定时做事(宿主直接建定时);/stop 停掉一个任务。
   * 插件命令照常作为带 command 的消息送达联系人。目标联系人:args.contact,私聊里缺省为对方。
   */
  private prepareBuiltin(room: RoomRow, input: SendInput): { mention?: string; after?: () => void } {
    const c = input.command;
    if (!c || !["task", "remind", "stop"].includes(c.name)) return {};
    const args = (c.args && typeof c.args === "object" && !Array.isArray(c.args) ? c.args : {}) as Record<string, unknown>;
    const str = (k: string) => (typeof args[k] === "string" ? (args[k] as string).trim() : "");
    const target = (): string => {
      const id = str("contact") || room.dm_contact || "";
      if (!id) throw new HostError("invalid_params", `/${c.name} 在群里要指定 contact`);
      if (!this.isMember(room.id, { kind: "contact", id })) throw new HostError("invalid_params", "这位联系人不在这个会话里");
      if (this.exits.isLeaving(room.id, id)) throw new HostError("conflict", "这位联系人正在移出这个群,不能再交活");
      return id;
    };
    if (c.name === "task") {
      if (!str("what")) throw new HostError("invalid_params", "/task 要写做什么(what)");
      return { mention: target() };
    }
    if (c.name === "remind") {
      const contactId = target();
      const cron = str("cron");
      const what = str("what");
      if (!cron || !what) throw new HostError("invalid_params", "/remind 要 cron 和 what");
      const tz = str("tz") || this.settings().timezone;
      checkCron(cron, tz);
      return { mention: contactId, after: () => this.scheduler.create({ contactId, roomId: room.id, title: what.slice(0, 40), cron, tz, prompt: what }) };
    }
    const ref = str("task");
    const live = this.listTasks({ roomId: room.id }).filter((t) => !TERMINAL.has(t.state) && t.state !== "T9_StopRequested");
    const t = live.find((x) => x.id === ref) ?? (ref ? live.filter((x) => x.title.includes(ref)) : []).at(0);
    if (!t) throw new HostError("not_found", ref ? `这个会话里没有进行中的任务「${ref}」` : "/stop 要指定任务");
    return { after: () => this.stopTask(t.id, this.userId) };
  }
  /** 停止任务(不另发消息):状态机 Cancel → 停 Compute,任务卡收口。 */
  stopTask(taskId: string, by: string) {
    const effects: HostEffect[] = [];
    tx(this.db, () => {
      const { effects: eff } = this.stepTaskTx(taskId, { kind: "Cancel", by });
      for (const e of eff) if (e.kind === "stop-compute") effects.push({ kind: "stop", taskId, computeId: e.computeId });
      for (const e of eff) if (e.kind === "cancel-spawn") effects.push({ kind: "cancel-spawn", taskId, requestId: e.requestId });
      this.afterCancelTx(taskId);
      run(this.db, "UPDATE gg_cards SET state = 'done' WHERE task_id = ? AND kind = 'task-status' AND state = 'open'", taskId);
    });
    this.emitTask(taskId);
    void this.runEffects(effects);
  }

  receipts(roomId: string, seq: number): ReceiptView {
    const msgs = this.projected(roomId);
    const m = msgs.find((x) => x.seq === seq);
    if (!m) throw new HostError("not_found", `没有 #${seq}`);
    const view = this.messageView(roomId, m, msgs);
    // 名单 = 成员(含联系人)减发送人(AC-46 ①)
    const audience = this.members(roomId).filter((x) => !(x.kind === m.sender.kind && x.id === m.sender.id));
    const read: ReceiptView["read"] = [];
    const unread: ReceiptView["unread"] = [];
    for (const mem of audience) {
      const mentioned = view.mentions.some((x) => x.id === mem.id);
      const first = one<{ at: string }>(this.db, "SELECT min(at) AS at FROM gg_read WHERE room_id = ? AND kind = ? AND member_id = ? AND upto_seq >= ?", roomId, mem.kind, mem.id, seq);
      if (first?.at) read.push({ member: mem, at: first.at, mentioned });
      else unread.push({ member: mem, mentioned });
    }
    const byMention = <T extends { mentioned: boolean }>(a: T, b: T) => Number(b.mentioned) - Number(a.mentioned);
    return { roomId, seq, read: read.sort(byMention), unread: unread.sort(byMention) };
  }

  /** 编辑自己的消息:追加编辑事件,不改旧事件;联系人下一轮收到「编辑了 #x」。 */
  editMessage(roomId: string, seq: number, text: string): MessageView {
    if (!text.trim()) throw new HostError("invalid_params", "消息不能为空");
    if (isRewound(this.db, roomId, seq)) throw new HostError("conflict", `#${seq} 已回退,不能再编辑`);
    this.appendUserEvent(roomId, { kind: "edit", target: seq, text });
    return this.updatedView(roomId, seq);
  }
  /** 撤回自己的消息:原文不再进任何联系人的上下文(AC-08)。 */
  retractMessage(roomId: string, seq: number): MessageView {
    this.appendUserEvent(roomId, { kind: "retract", target: seq });
    return this.updatedView(roomId, seq);
  }
  private appendUserEvent(roomId: string, body: { kind: "edit"; target: number; text: string } | { kind: "retract"; target: number }) {
    this.roomRow(roomId);
    try {
      tx(this.db, () => {
        appendEvent(this.db.store, `room:${roomId}`, { kind: "user", id: this.userId }, body, this.now());
        // 搜索索引同一事务更新:编辑只留新文字,撤回删行(AC-08 索引不再返回原文)
        if (body.kind === "edit") reindexEditTx(this.db, roomId, body.target, body.text);
        else unindexTx(this.db, roomId, body.target);
        run(this.db, "UPDATE gg_rooms SET updated_at = ? WHERE id = ?", this.now(), roomId);
      });
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === "target-not-found" || code === "target-not-message") throw new HostError("not_found", `没有消息 #${body.target}`);
      if (code === "not-original-sender") throw new HostError("forbidden", "只能改自己发的消息");
      if (code === "target-retracted") throw new HostError("conflict", "这条已撤回");
      throw e;
    }
    for (const mem of this.members(roomId)) if (mem.kind === "contact") this.loop.notify(mem.id, "batch");
  }
  private updatedView(roomId: string, seq: number): MessageView {
    const m = this.projected(roomId).find((x) => x.seq === seq);
    if (!m) throw new HostError("not_found", `没有消息 #${seq}`);
    const v = this.messageView(roomId, m);
    this.bus.emit({ type: "message.updated", message: v });
    this.bus.emit({ type: "room.updated", room: this.roomView(roomId) });
    return v;
  }
  /** 搜索自己所在会话的消息与附件名(AC-25);撤回的搜不到,编辑过的按新文字。 */
  searchMessages(q: SearchQuery): SearchPage {
    return searchMessages(this.db, this.userId, q, (s) => this.nameOf(s));
  }
  /** 表情回应:普通回应,不改已读状态(AC-46 ⑦)。 */
  react(roomId: string, seq: number, emoji: string, on: boolean): MessageView {
    if (!this.projected(roomId).some((m) => m.seq === seq)) throw new HostError("not_found", `没有消息 #${seq}`);
    if (on) run(this.db, "INSERT OR IGNORE INTO gg_reactions (room_id, seq, emoji, kind, member_id) VALUES (?, ?, ?, 'user', ?)", roomId, seq, emoji, this.userId);
    else run(this.db, "DELETE FROM gg_reactions WHERE room_id = ? AND seq = ? AND emoji = ? AND kind = 'user' AND member_id = ?", roomId, seq, emoji, this.userId);
    const m = this.projected(roomId).find((x) => x.seq === seq)!;
    const v = this.messageView(roomId, m);
    this.bus.emit({ type: "message.updated", message: v });
    return v;
  }
  // ======================= 输入框草稿 =======================
  // 客户端会话级未发送缓冲(AC-24、AC-37 ②;D11.5、C-US28):只存不送,绝不进联系人注意循环,也不产生会话事件。
  /** 某会话的草稿;没存过返回 draftVer = 0 的空草稿。 */
  draft(roomId: string): DraftView {
    this.userRoom(roomId);
    return getDoc<DraftView>(this.db, `draft:${roomId}`)?.value ?? { ...emptyDraft(roomId), quotedSeqs: [], mentions: [], updatedAt: null };
  }
  /** 按 draftVer 做 CAS 保存:expectedVer 必须等于当前版本,新版本必须更大;否则 conflict 带当前草稿。 */
  saveDraft(roomId: string, expectedVer: number, body: DraftBody): DraftView {
    this.userRoom(roomId);
    const bad = draftIssues({ roomId, ...body });
    if (bad.length) throw new HostError("invalid_params", `草稿不合格:${bad.join(";")}`);
    if (body.draftVer <= expectedVer) throw new HostError("invalid_params", `draftVer(${body.draftVer})必须大于 expectedVer(${expectedVer})`);
    const saved = tx(this.db, () => {
      const cur = getDoc<DraftView>(this.db, `draft:${roomId}`);
      const curVer = cur?.value.draftVer ?? 0;
      if (curVer !== expectedVer) throw new HostError("conflict", `草稿已被改过(当前版本 ${curVer})`, { current: cur?.value ?? this.draft(roomId) });
      const next: DraftView = { roomId, text: body.text, replyToSeq: body.replyToSeq, replyAuthorId: body.replyAuthorId, quotedSeqs: [...body.quotedSeqs], mentions: body.mentions.map((m) => ({ id: m.id, source: m.source })), draftVer: body.draftVer, updatedAt: this.now() };
      putDoc(this.db, `draft:${roomId}`, cur?.ver ?? 0, next);
      return next;
    });
    this.bus.emit({ type: "draft.updated", draft: saved });
    this.bus.emit({ type: "room.updated", room: this.roomView(roomId) });
    return saved;
  }
  /** 发送回执清理草稿(在 send 的事务里调用);草稿没变返回 null。 */
  private settleDraftTx(roomId: string, receipt: Parameters<typeof settleDraft>[1]): DraftView | null {
    const cur = getDoc<DraftView>(this.db, `draft:${roomId}`);
    if (!cur) return null;
    const before: ClientInputDraft = cur.value;
    const after = settleDraft(before, receipt);
    if (after === before) return null;
    const next: DraftView = { roomId, text: after.text, replyToSeq: after.replyToSeq, replyAuthorId: after.replyAuthorId, quotedSeqs: [...after.quotedSeqs], mentions: after.mentions.map((m) => ({ id: m.id, source: m.source })), draftVer: after.draftVer, updatedAt: this.now() };
    putDoc(this.db, `draft:${roomId}`, cur.ver, next);
    return next;
  }
  private userRoom(roomId: string): RoomRow {
    const room = this.roomRow(roomId);
    if (!this.isMember(room.id, { kind: "user", id: this.userId })) throw new HostError("forbidden", "你不在这个会话里");
    return room;
  }

  /** 附件:按内容 sha256 复制进数据目录,同一文件只存一份。 */
  addAttachment(file: string): { ref: string; name: string; mime: string; bytes: number } {
    if (!existsSync(file) || !statSync(file).isFile()) throw new HostError("invalid_params", `${file} 不是文件`);
    const bytes = statSync(file).size;
    if (bytes > 100 * 1024 * 1024) throw new HostError("invalid_params", "附件不能超过 100 MB");
    const sha = createHash("sha256").update(readFileSync(file)).digest("hex");
    const ref = `att-${sha.slice(0, 32)}`;
    const name = basename(file);
    const mime = MIME[extname(name).toLowerCase()] ?? "application/octet-stream";
    const dir = join(this.opts.dataDir ?? dirname(this.opts.file), "attachments");
    mkdirSync(dir, { recursive: true });
    const target = join(dir, `${sha}${extname(name).toLowerCase()}`);
    if (!existsSync(target)) copyFileSync(file, target);
    run(this.db, "INSERT OR IGNORE INTO gg_attachments (ref, name, mime, bytes, path, added_at) VALUES (?, ?, ?, ?, ?, ?)", ref, name, mime, bytes, target, this.now());
    return { ref, name, mime, bytes };
  }
  /**
   * 移出群成员;私聊不能移。联系人在这个群有在途任务(T8/T10/T11 以外)时默认拒绝,detail.tasks 列出;
   * stopTasks=true 时先标「移出中」(新消息不送达、发言与接新活被拒),在途任务 Cancel → 停 Compute,
   * 等每个任务都收到真实停止确认才删成员行(D05:取消请求本身不证明已释放)。它在别的群的任务不受影响。
   */
  removeMember(roomId: string, m: Member, opts: { stopTasks?: boolean } = {}): RoomView {
    const r = this.roomRow(roomId);
    if (r.kind === "dm") throw new HostError("forbidden", "私聊不能移出成员");
    if (!this.isMember(roomId, m)) throw new HostError("not_found", "不是这个群的成员");
    if (m.kind === "contact") {
      // 已在移出中:不重复发停止
      if (this.exits.isLeaving(roomId, m.id)) return this.roomView(roomId);
      const live = this.liveTasksIn(roomId, m.id);
      if (live.length) {
        if (!opts.stopTasks) {
          throw new HostError("conflict", `联系人在这个群还有 ${live.length} 个在途任务,先停止或等它完成;要一并停止请带 stopTasks`, { tasks: live.map((t) => ({ taskId: t.id, title: t.title, state: t.state })) });
        }
        this.exits.begin(roomId, m.id);
        this.bus.emit({ type: "room.updated", room: this.roomView(roomId) });
        for (const t of live) {
          if (t.state === "T9_StopRequested") continue;
          try {
            this.stopTask(t.id, this.userId);
          } catch (e) {
            this.report("exit-stop-failed", { roomId, contactId: m.id, taskId: t.id, error: e instanceof Error ? e.message : String(e) });
          }
        }
        this.settleExit(roomId, m.id);
        return this.roomView(roomId);
      }
      tx(this.db, () => this.exits.finishTx(roomId, m.id));
    } else run(this.db, "DELETE FROM gg_members WHERE room_id = ? AND kind = ? AND member_id = ?", roomId, m.kind, m.id);
    const view = this.roomView(roomId);
    this.bus.emit({ type: "room.updated", room: view });
    return view;
  }
  private liveTasksIn(roomId: string, contactId: string): TaskView[] {
    return this.listTasks({ roomId, contactId }).filter((t) => !EXIT_SETTLED.has(t.state));
  }
  /** 移出中的成员:它在这个群的在途任务全部停稳(T8/T10/T11)才真正删成员行并推 room.updated。 */
  private settleExit(roomId: string, contactId: string) {
    if (!this.exits.isLeaving(roomId, contactId) || this.liveTasksIn(roomId, contactId).length) return;
    tx(this.db, () => this.exits.finishTx(roomId, contactId));
    this.bus.emit({ type: "room.updated", room: this.roomView(roomId) });
  }
  /** 删除联系人:有在途任务时拒绝;删除后从所有群移出,私聊记录保留。 */
  removeContact(id: string) {
    const cur = this.contactDoc(id);
    const live = this.listTasks({ contactId: id }).filter((t) => !TERMINAL.has(t.state));
    if (live.length) throw new HostError("conflict", `联系人还有 ${live.length} 个在途任务,先取消或等它完成`);
    tx(this.db, () => {
      putDoc(this.db, `contact:${id}`, cur.ver, { ...cur.value, removed: true });
      run(this.db, "DELETE FROM gg_members WHERE kind = 'contact' AND member_id = ? AND room_id NOT IN (SELECT id FROM gg_rooms WHERE dm_contact = ?)", id, id);
      run(this.db, "UPDATE gg_schedules SET enabled = 0 WHERE contact_id = ?", id);
    });
    this.bus.emit({ type: "contact.removed", contactId: id });
  }
  /** 用户撤销联系人的一条承诺(用户只能撤销,不能替联系人标完成)。 */
  revokeCommitment(commitmentId: string): CommitmentView {
    for (const d of listDocs<Ledger>(this.db, "ledger:")) {
      const c = d.value.commitments.find((x) => x.id === commitmentId);
      if (!c) continue;
      const [, contactId, roomId] = d.key.split(":") as [string, string, string];
      if (c.status !== "active") throw new HostError("conflict", `承诺已是 ${c.status}`);
      tx(this.db, () =>
        this.ledgerTx(contactId, roomId, [{ type: "close", actionId: `revoke:${commitmentId}`, commitmentId, taskId: c.taskId, actor: { kind: "user", id: this.userId }, roundId: `revoke:${commitmentId}`, outcome: "revoked", artifact: null, detail: "用户撤销" }]),
      );
      const v = this.listCommitments({ contactId, roomId }).find((x) => x.id === commitmentId)!;
      this.bus.emit({ type: "commitment.updated", commitment: v });
      this.loop.notify(contactId, "batch");
      return v;
    }
    throw new HostError("not_found", `没有承诺 ${commitmentId}`);
  }
  /**
   * 显式的任务验收/退回/取消入口(AC-28:普通回复也能确认/退回,这两个是同一语义的显式入口)。
   * 取消等同点任务卡「取消任务」;验收/退回:旧数据里还开着的交付卡照点卡处理,否则直接对等你确认的交付下结论,
   * 并以用户回复那条交付消息的形式记进会话(决策是共享上下文)。
   */
  taskDecision(taskId: string, decision: "accept" | "reject" | "cancel", clientActionId: string, note?: string): TaskView {
    const doc = this.taskDoc(taskId).value;
    const kind = decision === "cancel" ? "task-status" : "delivery";
    const card = one<CardRow>(this.db, "SELECT * FROM gg_cards WHERE task_id = ? AND kind = ? AND state = 'open' ORDER BY seq DESC LIMIT 1", taskId, kind);
    if (card) {
      this.cardAct({ roomId: card.room_id, seq: card.seq, cardId: card.card_id, actionId: decision, clientActionId, ...(note ? { text: note } : {}) });
      return this.taskViewById(taskId);
    }
    if (decision === "cancel" || !awaitingUser(doc)) throw new HostError("conflict", decision === "cancel" ? `任务在 ${doc.task.state},不能取消` : `任务在 ${doc.task.state},没有待确认的交付`);
    const me: Member = { kind: "user", id: this.userId };
    const effects: HostEffect[] = [];
    const r = tx(this.db, () => {
      const m = this.appendMessageTx(doc.roomId, me, {
        text: decision === "accept" ? "通过" : `退回:${note?.trim() || "请继续修改"}`,
        actionKey: `user:${clientActionId}`,
        clientActionId,
        replyToSeq: doc.deliveredSeq ?? null,
        quotedSeqs: doc.deliveredSeq != null ? [doc.deliveredSeq] : [],
      });
      if (!m.duplicate) effects.push(...this.decideDeliveryTx(taskId, decision, this.userId, note?.trim() || "请继续修改"));
      return m;
    });
    if (!r.duplicate) {
      this.markRead(doc.roomId, me, r.seq);
      this.afterAppend(doc.roomId, r.seq, me);
      this.emitTask(taskId);
      void this.runEffects(effects);
    }
    return this.taskViewById(taskId);
  }

  // ======================= 私聊 rewind(AC-48)=======================
  /** 只读预览回退会影响到的东西;不改任何状态。 */
  rewindPreview(roomId: string, toSeq: number): RewindPlan {
    const room = this.roomRow(roomId);
    return planRewind(
      {
        room: { id: room.id, kind: room.kind },
        messages: this.projected(roomId),
        ranges: rewindRanges(this.db, roomId),
        tasks: this.listTasks({ roomId }),
        activeCommitments: this.listCommitments({ roomId, status: "active" }),
        computeRuns: (taskId) => all(this.db, "SELECT compute_id, status, result, started_at, ended_at FROM gg_compute WHERE task_id = ? ORDER BY started_at, compute_id", taskId),
      },
      toSeq,
    );
  }
  /**
   * 执行回退:撤下之后的消息、取消来源于它们的在途任务(状态机 Cancel,有 Compute 就等真实停止确认)、作废承诺,
   * 并以用户的一条对话消息记下回退说明(联系人经正常送达收到它、更新状态笔记;本轮途中的联系人因此放弃旧草稿重跑)。
   * 已发生的外部副作用只列出,不撤销;长期记忆与资产不动。clientActionId 幂等:重放原样返回第一次的结果。
   */
  rewind(input: { roomId: string; toSeq: number; clientActionId: string }): RewindResult {
    const prior = one<{ result: string }>(this.db, "SELECT result FROM gg_rewinds WHERE room_id = ? AND client_action_id = ?", input.roomId, input.clientActionId);
    if (prior) return JSON.parse(prior.result) as RewindResult;
    const plan = this.rewindPreview(input.roomId, input.toSeq);
    const roomId = input.roomId;
    const me: Member = { kind: "user", id: this.userId };
    const upto = this.lastSeq(roomId);
    const effects: HostEffect[] = [];
    const result = tx(this.db, () => {
      const tasks = plan.tasks.map((t) => {
        const { doc, effects: eff } = this.stepTaskTx(t.taskId, { kind: "Cancel", by: this.userId });
        for (const e of eff) if (e.kind === "stop-compute") effects.push({ kind: "stop", taskId: t.taskId, computeId: e.computeId });
        run(this.db, "UPDATE gg_cards SET state = 'expired' WHERE task_id = ? AND state = 'open'", t.taskId);
        return { ...t, state: doc.task.state };
      });
      const byContact = new Map<string, Parameters<typeof applyLedger>[2][]>();
      for (const k of plan.commitments) {
        const cmd = { type: "close" as const, actionId: `rewind:${roomId}:${input.clientActionId}:${k.commitmentId}`, commitmentId: k.commitmentId, taskId: k.taskId ?? this.ledgerTaskId(k.contactId, roomId, k.commitmentId), actor: { kind: "user" as const, id: this.userId }, roundId: `rewind:${input.clientActionId}`, outcome: "revoked" as const, artifact: null, detail: `用户回退到 #${input.toSeq}` };
        byContact.set(k.contactId, [...(byContact.get(k.contactId) ?? []), cmd]);
      }
      for (const [contactId, cmds] of byContact) this.ledgerTx(contactId, roomId, cmds);
      const markerSeq = this.appendMessageTx(roomId, me, {
        text: rewindNotice(plan),
        actionKey: `rewind:${input.clientActionId}`,
        clientActionId: input.clientActionId,
        replyToSeq: input.toSeq,
        quotedSeqs: [input.toSeq],
        command: { name: "rewind", args: { toSeq: input.toSeq, uptoSeq: upto } },
      }).seq;
      const r: RewindResult = { ...plan, tasks, markerSeq, at: this.now() };
      run(this.db, "INSERT INTO gg_rewinds (room_id, client_action_id, to_seq, upto_seq, marker_seq, result, at) VALUES (?, ?, ?, ?, ?, ?, ?)", roomId, input.clientActionId, input.toSeq, upto, markerSeq, JSON.stringify(r), r.at);
      return r;
    });
    this.markRead(roomId, me, result.markerSeq);
    const msgs = this.projected(roomId);
    for (const m of plan.messages) {
      const pm = msgs.find((x) => x.seq === m.seq);
      if (pm) this.bus.emit({ type: "message.updated", message: this.messageView(roomId, pm, msgs) });
    }
    this.afterAppend(roomId, result.markerSeq, me);
    for (const t of plan.tasks) this.emitTask(t.taskId);
    const changed = new Set(plan.commitments.map((k) => k.commitmentId));
    for (const k of this.listCommitments({ roomId })) if (changed.has(k.id)) this.bus.emit({ type: "commitment.updated", commitment: k });
    void this.runEffects(effects);
    return result;
  }
  private ledgerTaskId(contactId: string, roomId: string, commitmentId: string): string {
    return this.ledgerOf(contactId, roomId).value.commitments.find((c) => c.id === commitmentId)?.taskId ?? "";
  }

  // ======================= 手动新建任务(AC-47 候选底座 / U14)=======================
  /** 负责人必须是这个会话的联系人成员。 */
  private requireContactMember(roomId: string, contactId: string) {
    if (!this.isMember(roomId, { kind: "contact", id: contactId })) throw new HostError("invalid_params", "这位联系人不在这个会话里");
  }
  /** 事务内:负责人认领任务,返回起 Compute 的副作用(与联系人 dispatch 同一条派发路径)。 */
  private claimForTx(taskId: string, contactId: string): HostEffect[] {
    const contact = this.contactDoc(contactId).value;
    const { doc, effects: eff } = this.stepTaskTx(taskId, { kind: "Claim", by: contactId });
    return eff.flatMap((e): HostEffect[] => (e.kind === "spawn-compute" ? [{ kind: "spawn", taskId, requestId: e.requestId, contactId, model: this.computeModelOf(contact), brief: doc.brief, roomId: doc.roomId }] : []));
  }
  private actionTaskId(key: string): string | null {
    const prior = one<{ payload: string }>(this.db, "SELECT payload FROM actions WHERE action_id = ?", key);
    return prior ? (JSON.parse(prior.payload) as { taskId: string }).taskId : null;
  }
  /** 决策是共享上下文:消息落盘后推事件、送达联系人,再执行副作用。 */
  private afterManual(roomId: string, seq: number, taskId: string, effects: HostEffect[]): TaskView {
    const me: Member = { kind: "user", id: this.userId };
    this.markRead(roomId, me, seq);
    this.afterAppend(roomId, seq, me);
    this.emitTask(taskId);
    const view = this.taskView(this.taskDoc(taskId).value);
    void this.runEffects(effects);
    return view;
  }
  /** 用户手动新建任务;指定负责人时由它认领并起 Compute,否则停在 T1_Open。clientActionId 幂等。 */
  createTask(input: { clientActionId: string; roomId: string; title: string; description?: string; ownerContactId?: string }): TaskView {
    const room = this.roomRow(input.roomId);
    const me: Member = { kind: "user", id: this.userId };
    if (!this.isMember(room.id, me)) throw new HostError("forbidden", "你不在这个会话里");
    const key = `task-create:${room.id}:${input.clientActionId}`;
    const prior = this.actionTaskId(key);
    if (prior) return this.taskView(this.taskDoc(prior).value);
    const title = input.title.trim();
    if (!title) throw new HostError("invalid_params", "任务标题不能为空");
    const owner = input.ownerContactId;
    if (owner !== undefined) this.requireContactMember(room.id, owner);
    const description = input.description?.trim() ? input.description : undefined;
    const brief = description ? `${title}\n\n${description}` : title;
    const taskId = this.newId("t");
    const effects: HostEffect[] = [];
    const seq = tx(this.db, () => {
      const s = this.appendMessageTx(room.id, me, {
        text: description ? `新建任务:${title}\n${description}` : `新建任务:${title}`,
        actionKey: `user:${input.clientActionId}`,
        clientActionId: input.clientActionId,
        mentions: owner !== undefined ? [{ id: owner, source: "auto" }] : [],
        card: { card_id: this.newId("card"), kind: "task-status", task_id: taskId, title: title.slice(0, 200), body: brief.slice(0, 20000), state: "open", actions: JSON.stringify([{ actionId: "cancel", label: "取消任务", style: "danger" }]), meta: "{}" },
      }).seq;
      const doc: TaskDoc = { task: newTask(taskId, this.userId), title: title.slice(0, 500), roomId: room.id, sourceSeq: s, brief, createdAt: this.now(), updatedAt: this.now(), result: null, ...(description ? { description } : {}) };
      putDoc(this.db, `task:${taskId}`, 0, doc);
      if (owner !== undefined) effects.push(...this.claimForTx(taskId, owner));
      recordAction(this.db.store, key, { taskId });
      return s;
    });
    return this.afterManual(room.id, seq, taskId, effects);
  }
  /** 给还没人负责的任务指定负责人,由它认领并起 Compute。clientActionId 幂等。 */
  assignTask(input: { taskId: string; contactId: string; clientActionId: string }): TaskView {
    const key = `task-assign:${input.clientActionId}`;
    const prior = this.actionTaskId(key);
    if (prior) return this.taskView(this.taskDoc(prior).value);
    const doc = this.taskDoc(input.taskId).value;
    this.requireContactMember(doc.roomId, input.contactId);
    if (doc.task.state !== "T1_Open" || doc.task.owner !== null) throw new HostError("conflict", `任务在 ${doc.task.state},不能再指定负责人`);
    const me: Member = { kind: "user", id: this.userId };
    const effects: HostEffect[] = [];
    const seq = tx(this.db, () => {
      const s = this.appendMessageTx(doc.roomId, me, {
        text: `把任务「${doc.title}」交给 ${this.nameOf({ kind: "contact", id: input.contactId })}`,
        actionKey: `user:${input.clientActionId}`,
        clientActionId: input.clientActionId,
        replyToSeq: doc.sourceSeq,
        quotedSeqs: [doc.sourceSeq],
        mentions: [{ id: input.contactId, source: "auto" }],
      }).seq;
      effects.push(...this.claimForTx(input.taskId, input.contactId));
      recordAction(this.db.store, key, { taskId: input.taskId });
      return s;
    });
    return this.afterManual(doc.roomId, seq, input.taskId, effects);
  }

  // ======================= 任务 =======================
  taskDoc(id: string): { value: TaskDoc; ver: number } {
    const d = getDoc<TaskDoc>(this.db, `task:${id}`);
    if (!d) throw new HostError("not_found", `没有任务 ${id}`);
    return d;
  }
  /** 在事务里推进任务状态机;被状态机拒绝抛 conflict。 */
  private stepTaskTx(id: string, ev: TaskEvent, extra: Partial<TaskDoc> = {}): { doc: TaskDoc; effects: ReturnType<typeof applyTask> extends infer O ? (O extends { ok: true; effects: infer E } ? E : never) : never } {
    const cur = this.taskDoc(id);
    const out = applyTask(cur.value.task, ev);
    if (!out.ok) throw new HostError("conflict", `任务 ${id} 拒绝 ${ev.kind}:${out.reason}`);
    const doc: TaskDoc = { ...cur.value, ...extra, task: out.task, updatedAt: this.now() };
    putDoc(this.db, `task:${id}`, cur.ver, doc);
    return { doc, effects: out.effects };
  }
  /** 按 id 读权威任务文档(正文与版本同一次读出)投影成视图;群入口、侧边栏、事件都走这里或 listTasks,不读缓存副本(AC-02) */
  taskViewById(id: string): TaskView {
    const d = this.taskDoc(id);
    return this.taskView(d.value, d.ver);
  }
  /** ver 不给时按 id 读当前权威版本 */
  taskView(doc: TaskDoc, ver?: number): TaskView {
    const runs = all<{ compute_id: string; harness: string; model: string; status: string; started_at: string; ended_at: string | null }>(
      this.db,
      "SELECT * FROM gg_compute WHERE task_id = ? ORDER BY started_at",
      doc.task.id,
    );
    const progress = this.progress(doc.task.id, 20);
    const t = doc.task;
    return {
      id: t.id,
      title: doc.title,
      roomId: doc.roomId,
      sourceSeq: doc.sourceSeq,
      requesterId: t.requester,
      ownerContactId: t.owner,
      state: t.state,
      constraintVersion: t.constraintVer,
      pendingQuestion: t.pendingQ ? { qId: t.pendingQ.qId, text: "" } : null,
      reviewGate: t.reviewGate,
      computeRuns: runs.map((r) => {
        const loaded = getDoc<{ skills: string[]; mcpServers: string[] }>(this.db, `compute-loaded:${r.compute_id}`)?.value;
        return {
          computeId: r.compute_id,
          harness: r.harness as "claude-code",
          model: r.model,
          placement: "local" as const,
          status: r.status as TaskView["computeRuns"][number]["status"],
          startedAt: r.started_at,
          endedAt: r.ended_at,
          ...(loaded ? { loaded } : {}),
        };
      }),
      recentProgress: progress,
      modelSnapshot: doc.models?.initial ? { ...doc.models.initial } : null,
      modelAttempts: (doc.models?.attempts ?? []).map((a) => ({ ...a })),
      producerVendors: [...producerVendors(doc.models ?? emptyModelRecord)],
      artifacts: [
        ...(doc.result ? [{ ref: `task:${t.id}/result`, name: "结果", kind: "text" as const }] : []),
        ...(doc.artifacts ?? []).map((a) => ({ ref: a.ref, name: a.name, kind: "file" as const, sha256: a.sha256, bytes: a.bytes, mime: a.mime })),
      ],
      ...this.workspaceField(t.id),
      waitingFor: this.quota.waitingReason(t.id) ?? this.stopUnconfirmed.get(t.id) ?? null,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
      ...(doc.description !== undefined ? { description: doc.description } : {}),
      stateVer: ver ?? this.taskDoc(t.id).ver,
    };
  }
  progress(taskId: string, limit = 200): ComputeProgress[] {
    return all<{ compute_id: string; kind: ComputeProgress["kind"]; stage: string | null; summary: string; at: string }>(
      this.db,
      "SELECT * FROM (SELECT * FROM gg_progress WHERE task_id = ? ORDER BY id DESC LIMIT ?) ORDER BY id",
      taskId,
      limit,
    ).map((p) => ({ computeId: p.compute_id, taskId, kind: p.kind, ...(p.stage ? { stage: p.stage } : {}), summary: p.summary, at: p.at }));
  }
  listTasks(q: { roomId?: string; contactId?: string; states?: string[] }): TaskView[] {
    return listDocs<TaskDoc>(this.db, "task:")
      .filter(({ value: d }) => (!q.roomId || d.roomId === q.roomId) && (!q.contactId || d.task.owner === q.contactId) && (!q.states || q.states.includes(d.task.state)))
      .sort((a, b) => (a.value.createdAt < b.value.createdAt ? 1 : -1))
      .map((d) => this.taskView(d.value, d.ver));
  }
  private emitTask(id: string) {
    this.bus.emit({ type: "task.updated", task: this.taskViewById(id) });
    const doc = this.taskDoc(id).value;
    // 任务每次变化后看负责人是否在这个群移出中:停止确认到了(T10/T11)才真正移出
    if (doc.task.owner) this.settleExit(doc.roomId, doc.task.owner);
  }

  // ======================= 代码工作树(R-Worktree,AC-22) =======================
  workspace(taskId: string): { value: Workspace; ver: number } | undefined {
    return getDoc<Workspace>(this.db, `ws:${taskId}`);
  }
  private workspaceField(taskId: string): { workspace?: NonNullable<TaskView["workspace"]> } {
    const w = this.workspace(taskId)?.value;
    if (!w) return {};
    return { workspace: { dir: w.dir, branch: w.branch, targetBranch: w.targetBranch, baseSha: w.baseSha, candidateSha: w.candidateSha, state: w.state, targetHead: w.targetHead, verifiedOn: w.verifiedOn, mergedSha: w.mergedSha, conflict: w.conflict } };
  }
  // ======================= 工件(AC-04) =======================
  /** 交付消息带回的工件(AC-04);没有就不带这个字段 */
  private messageArtifacts(roomId: string, seq: number): { artifacts?: ArtifactRef[] } {
    const row = one<{ artifacts: string }>(this.db, "SELECT artifacts FROM gg_msg_artifacts WHERE room_id = ? AND seq = ?", roomId, seq);
    return row ? { artifacts: JSON.parse(row.artifacts) as ArtifactRef[] } : {};
  }
  /** 收集本次交付的可读工件:代码任务读钉住的候选提交里改过的文件(不读工作区);
   *  否则在 Compute 工作目录里找本任务 Compute 启动后改过的文件(按修改时间,局限见 recentReadable)。 */
  private collectArtifacts(taskId: string): ArtifactRef[] {
    const out: ArtifactRef[] = [];
    const ws = this.workspace(taskId)?.value;
    if (ws && this.worktrees && ws.candidateSha) {
      for (const f of this.worktrees.changedFiles(ws).filter(isReadable).slice(0, MAX_ARTIFACTS)) {
        const data = this.worktrees.readAt(ws.candidateSha, f);
        if (data.length <= MAX_ARTIFACT_BYTES) out.push(this.artifacts.put(f, data));
      }
      return out;
    }
    const cwd = this.opts.computeCwd?.(taskId);
    const started = one<{ s: string | null }>(this.db, "SELECT MIN(started_at) AS s FROM gg_compute WHERE task_id = ?", taskId)?.s;
    if (!cwd || !started) return out;
    for (const rel of recentReadable(cwd, Date.parse(started) - 2000)) out.push(this.artifacts.put(rel, readFileSync(join(cwd, rel))));
    return out;
  }
  /** 读工件快照(卡片点开):内容 hash 与卡片里的一致;文本类小文件直接带回正文。 */
  getArtifact(ref: string): ArtifactRef & { path: string; text: string | null } {
    const r = this.artifacts.read(ref);
    if (!r) throw new HostError("not_found", `没有工件 ${ref}`);
    const textual = r.meta.mime.startsWith("text/") || r.meta.mime === "image/svg+xml";
    return { ...r.meta, text: textual && r.data.length <= MAX_INLINE_TEXT ? r.data.toString("utf8") : null };
  }
  /** Compute 工作目录:配了代码仓就是这个任务自己的 worktree(没有就现开),否则按 computeCwd。 */
  private computeCwdFor(taskId: string): string | undefined {
    if (!this.worktrees) return this.opts.computeCwd?.(taskId);
    const cur = this.workspace(taskId);
    const ws = this.worktrees.provision(taskId, cur?.value ?? null);
    if (ws !== cur?.value) putDoc(this.db, `ws:${taskId}`, cur?.ver ?? 0, ws);
    return ws.dir;
  }
  /** 受控合入(W3 → W4 → W6/W5)。审查已过、交付等确认(T8a)的代码任务才能合;合入成功才记验收并了结承诺,
   *  冲突或重验失败如实告诉联系人,目标分支不动,任务停在 T8a 等退回修复(退回前再说通过也会被拒)。 */
  async integrateTask(taskId: string, by: string = this.userId): Promise<TaskView> {
    const wt = this.worktrees;
    const cur = this.workspace(taskId);
    if (!wt || !cur) throw new HostError("invalid_params", `任务 ${taskId} 没有代码工作树`);
    const doc = this.taskDoc(taskId).value;
    if (cur.value.state === "W6_Merged") return this.taskView(doc);
    if (doc.task.state !== "T8a_Delivered") throw new HostError("conflict", `任务在 ${doc.task.state}:审查通过、交付之后才能合入`);
    if (cur.value.state !== "W3_Pinned") throw new HostError("conflict", cur.value.state === "W5_Conflict" ? "上次合入冲突或重验失败,要先退回修复、提交新的候选" : `工作树在 ${cur.value.state},不能合入`);
    const ver = putDoc(this.db, `ws:${taskId}`, cur.ver, { ...cur.value, state: "W4_Integrating" });
    this.emitTask(taskId);
    const r = await wt.integrate(cur.value);
    const owner = doc.task.owner;
    const at = this.now();
    tx(this.db, () => {
      putDoc(this.db, `ws:${taskId}`, ver, r.ws);
      const t = this.taskDoc(taskId).value.task;
      let summary: string;
      if (r.ok) {
        if (t.state === "T8a_Delivered" && t.delivery) this.stepTaskTx(taskId, { kind: "UserAccept", taskId, by, deliveryRound: t.delivery.round, commit: t.delivery.commit });
        this.closeCommitmentsTx(owner, doc.roomId, taskId, "done");
        run(this.db, "UPDATE gg_cards SET state = 'done' WHERE task_id = ? AND kind = 'task-status' AND state = 'open'", taskId);
        summary = `已合入 ${r.ws.targetBranch}@${(r.ws.mergedSha ?? "").slice(0, 12)}(${r.mode === "fast-forward" ? "主线未变,快进" : r.mode === "no-change" ? "候选已在主线里" : `主线已推进到 ${(r.ws.verifiedOn ?? "").slice(0, 12)},合并后重验通过`})`;
      } else {
        summary = `合入失败,${r.ws.targetBranch} 未改动:${r.detail}${r.reason === "target-busy" ? "。可以再说一次通过重试" : "。需要退回,基于最新主线修复后重新交付"}`;
      }
      if (owner) {
        const payload: Inbound = { kind: "compute", roomId: doc.roomId, taskId, computeId: t.computeId ?? "-", signal: r.ok ? "milestone" : "failed", summary, at };
        run(this.db, "INSERT INTO gg_inbox (contact_id, room_id, payload, at) VALUES (?, ?, ?, ?)", owner, doc.roomId, JSON.stringify(payload), at);
      }
    });
    this.emitTask(taskId);
    if (owner) this.loop.notify(owner, "now");
    return this.taskView(this.taskDoc(taskId).value);
  }
  /** 代码任务的「通过」不能直接记验收:冲突未修或正在合入时拒绝,其余先豁免审查到 T8a 再发起合入。null = 不是待合入的代码任务。 */
  private acceptCodeTaskTx(taskId: string, by: string): HostEffect[] | null {
    const ws = this.workspace(taskId)?.value;
    if (!ws || ws.state === "W6_Merged") return null;
    if (ws.state === "W5_Conflict") throw new HostError("conflict", "上次合入冲突或重验失败,先退回让联系人基于最新主线修复、重新交付");
    if (ws.state === "W4_Integrating") throw new HostError("conflict", "正在合入,等结果");
    const t = this.taskDoc(taskId).value.task;
    if (t.state === "T5_InReview") {
      const owner = t.owner ? getDoc<ContactDoc>(this.db, `contact:${t.owner}`)?.value : undefined;
      const { effects: eff } = this.stepTaskTx(taskId, { kind: "Review", reviewerId: by, reviewerModel: owner?.speakingModel ?? this.settings().defaultSpeakingModel, round: t.reviewRound, commit: t.reviewedCommit ?? "", constraintVer: t.constraintVer, waiverBy: by, verdict: "approve" });
      const send = eff.find((e) => e.kind === "send-card");
      if (send && send.kind === "send-card") this.stepTaskTx(taskId, { kind: "DeliveredCard", taskId, deliveryRound: send.deliveryRound, commit: send.commit });
    } else if (t.state !== "T8a_Delivered") throw new HostError("conflict", `任务在 ${t.state},没有待确认的交付`);
    return [{ kind: "integrate", taskId, by }];
  }

  // ======================= 承诺账本 =======================
  private ledgerKey(contactId: string, roomId: string) {
    return `ledger:${contactId}:${roomId}`;
  }
  private ledgerOf(contactId: string, roomId: string): { value: Ledger; ver: number } {
    const d = getDoc<Ledger>(this.db, this.ledgerKey(contactId, roomId));
    if (d) return d;
    const e = emptyLedger(contactId);
    if ("ok" in e) throw new HostError("internal", `建账本失败:${e.reason}`);
    return { value: e, ver: 0 };
  }
  /** 在事务里依次应用账本命令;任何一条失败整次提交回滚。 */
  private ledgerTx(contactId: string, roomId: string, cmds: Parameters<typeof applyLedger>[2][]) {
    if (!cmds.length) return;
    const cur = this.ledgerOf(contactId, roomId);
    let led = cur.value;
    for (const c of cmds) {
      const r = applyLedger(led, led.version, c, (ref) => this.artifactExists(ref));
      if (!r.ok) throw new HostError("conflict", `承诺账本拒绝 ${c.type}:${r.reason}`);
      led = r.ledger;
    }
    putDoc(this.db, this.ledgerKey(contactId, roomId), cur.ver, led);
  }
  private artifactExists(ref: string): boolean {
    const m = /^task:(.+)\/result$/.exec(ref);
    return !!m && !!getDoc<TaskDoc>(this.db, `task:${m[1]}`)?.value.result;
  }
  listCommitments(q: { contactId?: string; roomId?: string; status?: string }): CommitmentView[] {
    const out: CommitmentView[] = [];
    for (const d of listDocs<Ledger>(this.db, "ledger:")) {
      const [, contactId, roomId] = d.key.split(":") as [string, string, string];
      if ((q.contactId && q.contactId !== contactId) || (q.roomId && q.roomId !== roomId)) continue;
      for (const c of d.value.commitments) {
        if (q.status && c.status !== q.status) continue;
        out.push({ id: c.id, contactId, roomId, sourceSeq: c.sourceSeq, taskId: c.taskId.startsWith("standing-") ? null : c.taskId, text: c.text, status: c.status, scheduleId: null, updatedAt: this.now() });
      }
    }
    return out;
  }
  private activeLedgerLines(contactId: string): LedgerLine[] {
    const out: LedgerLine[] = [];
    for (const d of listDocs<Ledger>(this.db, `ledger:${contactId}:`)) {
      const roomId = d.key.slice(`ledger:${contactId}:`.length);
      for (const c of d.value.commitments) if (c.status === "active") out.push({ id: c.id, roomId, sourceSeq: c.sourceSeq, taskId: c.taskId, text: c.text, status: c.status });
    }
    return out;
  }

  // ======================= 联系人一轮 =======================
  /** 联系人当前的状态笔记(第 3 块原文);没有为 null。 */
  stateNote(contactId: string): string | null {
    return getDoc<{ text: string }>(this.db, `note:${contactId}`)?.value.text ?? null;
  }
  /** 这些会话里被撤回消息的全部原文(含撤回前的编辑稿);撤回优先(AC-08),这些原文不能经状态笔记回到请求 */
  private retractedTexts(roomIds: readonly string[]): string[] {
    const out: string[] = [];
    for (const roomId of roomIds) {
      const { log } = loadLog(this.db.store, `room:${roomId}`);
      const gone = new Set<number>();
      for (const e of log.events) if (e.body.kind === "retract") gone.add(e.body.target);
      if (gone.size === 0) continue;
      for (const e of log.events) {
        if (e.body.kind === "message" && gone.has(e.seq)) out.push(e.body.text);
        if (e.body.kind === "edit" && gone.has(e.body.target)) out.push(e.body.text);
      }
    }
    return out;
  }
  /** 笔记落盘或装配前移除撤回原文;精确替换不掉就整份作废并报告 */
  private scrubNote(contactId: string, note: string, roomIds: readonly string[]): string {
    const r = scrubRetracted(note, this.retractedTexts(roomIds));
    if (r.leaked) {
      this.report("state-note-voided", { contactId });
      return VOIDED_NOTE;
    }
    if (r.hits > 0) this.report("state-note-scrubbed", { contactId, hits: r.hits });
    return r.text;
  }
  /** 本轮要落盘的状态笔记:模型没写就请压缩器补写(同一说话模型的独立调用),超上限就缩写;最后移除撤回原文 */
  private async settleNote(contact: ContactDoc, fresh: readonly Inbound[], out: RoundOutput, roomIds: readonly string[], signal: AbortSignal): Promise<string | null> {
    const contactId = contact.id;
    const prev = this.stateNote(contactId);
    const compactor = this.opts.compactor?.(this.contactView(contact));
    const profile = { id: contactId, name: contact.name, speakingModel: contact.speakingModel, persona: contact.persona };
    const max = this.opts.stateNoteMaxBytes ?? null;
    let note = out.stateNote;
    if (note === null && compactor && fresh.length > 0) {
      try {
        note = await compactor.compact({ contact: profile, kind: "round-note", previous: prev, material: compactMaterial(fresh, out.actions), maxBytes: max }, signal);
      } catch (e) {
        this.report("compact-failed", { contactId, kind: "round-note", error: e instanceof Error ? e.message : String(e) });
        note = null;
      }
    }
    if (note !== null && max !== null && Buffer.byteLength(note, "utf8") > max) {
      if (compactor) {
        try {
          const shorter = await compactor.compact({ contact: profile, kind: "shrink", previous: note, material: "", maxBytes: max }, signal);
          if (Buffer.byteLength(shorter, "utf8") < Buffer.byteLength(note, "utf8")) note = shorter;
        } catch (e) {
          this.report("compact-failed", { contactId, kind: "shrink", error: e instanceof Error ? e.message : String(e) });
        }
      }
      if (Buffer.byteLength(note, "utf8") > max) this.report("state-note-over-limit", { contactId, bytes: Buffer.byteLength(note, "utf8"), max });
    }
    return note === null ? null : this.scrubNote(contactId, note, roomIds);
  }
  private cursor(contactId: string, roomId: string): number {
    return one<{ processed_seq: number }>(this.db, "SELECT processed_seq FROM gg_cursor WHERE contact_id = ? AND room_id = ?", contactId, roomId)?.processed_seq ?? 0;
  }
  private inbox(contactId: string): { id: number; room_id: string; payload: string }[] {
    return all(this.db, "SELECT id, room_id, payload FROM gg_inbox WHERE contact_id = ? AND consumed = 0 ORDER BY id", contactId);
  }
  /** 一条消息落盘的回复与引用(原样,不过滤):给引用召回规划逐条判定,伪造或越界的引用在那里显式 AccessDenied。 */
  private rawRefs(roomId: string, seq: number): { replyTo: number | null; quoted: number[] } {
    const meta = one<MsgMeta>(this.db, "SELECT reply_to, quoted FROM gg_msg WHERE room_id = ? AND seq = ?", roomId, seq);
    return { replyTo: meta?.reply_to ?? null, quoted: meta ? (JSON.parse(meta.quoted) as number[]) : [] };
  }
  private toInbound(roomId: string, m: ProjectedMessage): InboundMessage {
    const meta = one<MsgMeta>(this.db, "SELECT * FROM gg_msg WHERE room_id = ? AND seq = ?", roomId, m.seq);
    // 第 4 块只标指向更早消息的引用(五块装配的输入合同);指向本条之后的引用不可能是真引用,交召回规划判 AccessDenied
    const earlier = (q: number) => Number.isSafeInteger(q) && q >= 1 && q < m.seq;
    const replyTo = meta?.reply_to ?? null;
    return {
      kind: "message",
      roomId,
      seq: m.seq,
      sender: { kind: m.sender.kind, id: m.sender.id, name: this.nameOf(m.sender) },
      text: m.text,
      replyToSeq: replyTo !== null && earlier(replyTo) ? replyTo : null,
      quotedSeqs: meta ? (JSON.parse(meta.quoted) as number[]).filter(earlier) : [],
      mentions: meta ? (JSON.parse(meta.mentions) as { id: string }[]).map((x) => x.id) : [],
      command: meta?.command ? (JSON.parse(meta.command) as { name: string; args: unknown }) : null,
      at: one<{ at: string }>(this.db, "SELECT at FROM events WHERE session = ? AND seq = ?", `room:${roomId}`, m.seq)?.at ?? this.now(),
    };
  }

  async runRound(contactId: string, signal: AbortSignal): Promise<RoundStatus> {
    if (this.closed) return "done";
    const contact = this.contactDoc(contactId).value;
    // 移出中的群不再送达新消息,也不再装配进它的上下文
    const leavingRooms = this.exits.leavingRoomsOf(contactId);
    const rooms = this.roomsOfContact(contactId).filter((r) => !leavingRooms.has(r.id));
    const fresh: Inbound[] = [];
    const ownOnly: { roomId: string; seq: number }[] = [];
    const lastSeen: Record<string, number> = {};
    // 被引用消息的确定性 Page-in(D06.3):逐条收集引用,统一交召回规划判权限、撤回与公平预算
    const refs: RecallRef[] = [];
    const sources = new Map<string, RecallSource & { sender: string }>();
    for (const r of rooms) {
      const cur = this.cursor(contactId, r.id);
      const { log } = loadLog(this.db.store, `room:${r.id}`);
      const msgs = project(log);
      // 私聊 rewind 撤下的消息(AC-48):不再送达,针对它们的编辑/撤回也不送达,引用它们也不换入
      const rewound = rewindRanges(this.db, r.id);
      lastSeen[r.id] = log.events.at(-1)?.seq ?? 0;
      // 按事件扫:编辑与撤回是新事件(只追加),作为「编辑 #x 为…」「撤回了 #x」送达,不回头改旧消息
      for (const ev of log.events) {
        if (ev.seq <= cur) continue;
        if (ev.sender.kind === "contact" && ev.sender.id === contactId) {
          ownOnly.push({ roomId: r.id, seq: ev.seq });
          continue;
        }
        let ib: InboundMessage;
        if (inRanges(rewound, ev.body.kind === "message" ? ev.seq : ev.body.target)) continue;
        if (ev.body.kind === "message") {
          const m = msgs.find((x) => x.seq === ev.seq);
          if (!m || m.retracted) continue;
          ib = this.toInbound(r.id, m);
        } else {
          const target = ev.body.target;
          const tm = msgs.find((x) => x.seq === target);
          if (ev.body.kind === "edit" && tm?.retracted) continue;
          ib = {
            kind: "message",
            roomId: r.id,
            seq: ev.seq,
            sender: { kind: ev.sender.kind, id: ev.sender.id, name: this.nameOf(ev.sender) },
            text: ev.body.kind === "edit" ? `(编辑了 #${target})${ev.body.text}` : `(撤回了 #${target})`,
            replyToSeq: target,
            quotedSeqs: [],
            mentions: [],
            command: null,
            at: ev.at,
          };
        }
        fresh.push(ib);
        const raw = ev.body.kind === "message" ? this.rawRefs(r.id, ev.seq) : { replyTo: ev.body.target, quoted: [] };
        for (const q of [...(raw.replyTo !== null ? [raw.replyTo] : []), ...raw.quoted]) {
          const src = msgs.find((x) => x.seq === q);
          // 已在本批第 4 块里的消息不再换入(AC-06:引用窗口内消息不触发 Page-in)
          if (src && !src.retracted && fresh.some((f) => f.kind === "message" && f.roomId === r.id && f.seq === q)) continue;
          refs.push({ fromRoomId: r.id, roomId: r.id, seq: q, primary: q === raw.replyTo });
          // 私聊 rewind 撤下的消息(AC-48)不换入原文:按撤回处理,只给占位,原文不进召回规划
          const gone = !!src && inRanges(rewound, src.seq);
          if (src && !sources.has(`${r.id}#${q}`)) sources.set(`${r.id}#${q}`, { roomId: r.id, seq: q, text: gone ? "" : src.text, retracted: src.retracted || gone, sender: this.nameOf(src.sender) });
        }
      }
    }
    const inbox = this.inbox(contactId);
    for (const i of inbox) fresh.push(JSON.parse(i.payload) as Inbound);
    if (fresh.length === 0) {
      if (ownOnly.length) tx(this.db, () => this.advanceCursorsTx(contactId, lastSeen));
      return "done";
    }
    const focusRoom = fresh.find((f) => f.kind === "message")?.roomId ?? fresh[0]?.roomId ?? null;
    // 失败轮次容错(AC-36):已出失败卡的联系人停在原位等用户处理(新消息留着,不被吞也不被接走);
    // 共享熔断打开时不调模型,暂停到半开探测或用户在群级卡上点重试
    const processedNow: Record<string, number> = Object.fromEntries(rooms.map((r) => [r.id, this.cursor(contactId, r.id)]));
    const inboxEnd = inbox.at(-1)?.id ?? 0;
    const prior = this.failureRow("contact", contactId);
    if (prior?.status === "card") return "done";
    const model = prior?.model_override ?? contact.speakingModel;
    const upstream = this.upstreamKey(model);
    if (!this.admitUpstream(upstream, "interactive")) {
      this.pauseBehindBreaker("contact", contactId, contactId, upstream, focusRoom, prior ? null : processedNow, inboxEnd);
      return "done";
    }
    const roundId = `${contactId}:r${++this.roundNo}:${Date.now().toString(36)}`;
    // 接走即已读(AC-46 ④):开始这一轮就推进已读位置,与 processed_seq 无关
    for (const r of rooms) if (fresh.some((f) => f.kind === "message" && f.roomId === r.id)) this.markRead(r.id, { kind: "contact", id: contactId }, lastSeen[r.id] ?? 0);
    this.setActivity(contactId, focusRoom, "thinking");
    const tasks = this.listTasks({ contactId }).filter((t) => !TERMINAL.has(t.state));
    let note = getDoc<{ text: string }>(this.db, `note:${contactId}`);
    if (note) {
      const clean = this.scrubNote(contactId, note.value.text, rooms.map((r) => r.id));
      if (clean !== note.value.text) {
        putDoc(this.db, `note:${contactId}`, note.ver, { text: clean });
        note = getDoc<{ text: string }>(this.db, `note:${contactId}`);
      }
    }
    const ledgerLines = this.activeLedgerLines(contactId);
    const freshKeys = new Set(fresh.flatMap((f) => (f.kind === "message" ? [`${f.roomId}#${f.seq}`, ...(f.replyToSeq !== null ? [`${f.roomId}#${f.replyToSeq}`] : [])] : [])));
    const freshTasks = new Set(fresh.flatMap((f) => (f.kind === "compute" ? [f.taskId] : [])));
    const plan = planRecall({
      refs,
      readableRooms: rooms.map((r) => r.id),
      sources: [...sources.values()].map(({ sender: _s, ...src }) => src),
      budgetBytes: this.opts.recallBudgetBytes ?? RECALL_BUDGET_BYTES,
      minSliceBytes: this.opts.recallMinSliceBytes ?? RECALL_MIN_SLICE_BYTES,
    });
    if (!plan.ok) {
      if (plan.reason === "over-budget") return this.failRound(contactId, roundId, focusRoom ?? fresh[0]!.roomId, lastSeen, inbox, { reason: "recall-over-budget", need: plan.need, budget: plan.budget, detail: plan.detail });
      this.setActivity(contactId, null, "idle");
      throw new Error(`引用召回规划失败:${plan.detail}`);
    }
    this.report("recall", { contactId, roundId, items: plan.items.map(({ text: _t, ...rest }) => rest) });
    const pointers = plan.items.map((it) => renderRecall(it, sources.get(`${it.roomId}#${it.seq}`)?.sender ?? "?"));
    let request: ReturnType<RoundAssembler>;
    try {
      request = this.assemble({
      system: CONTACT_SYSTEM,
      tools: CONTACT_TOOLS,
      persona: identityOf(contactId, contact),
      // 第 1 块群规快照 = 群规 + 当前全部有效公告(U86);版本只在两者真改时前进(U85/D22)
      roomRules: rooms.map((r) => ({ roomId: r.id, title: r.title, ...this.announcements.snapshot(r.id, r.rules, r.rules_version) })),
      ledger: ledgerLines,
      boundIds: ledgerLines.filter((l) => freshKeys.has(`${l.roomId}#${l.sourceSeq}`) || freshTasks.has(l.taskId)).map((l) => l.id),
      processedSeq: Object.fromEntries(rooms.map((r) => [r.id, this.cursor(contactId, r.id)])),
      stateNoteVersion: note?.ver ?? 0,
      stateNote: note?.value.text ?? null,
      fresh,
      tasks: tasks.map((t) => `${t.id} [${t.state}] ${t.title}(会话 ${t.roomId} #${t.sourceSeq})`),
      pointers,
      budgetBytes: this.opts.roundBudgetBytes ?? ROUND_BUDGET_BYTES,
      });
    } catch (e) {
      // 整轮超预算(D06 §2):显式失败——不截断、不调模型、游标不推进;出失败卡交用户重试或跳过,不在后台反复重跑
      if (e instanceof RoundAssembleError && e.reason === "over-budget" && e.need !== null && e.budget !== null) {
        return this.failRound(contactId, roundId, focusRoom ?? fresh[0]!.roomId, lastSeen, inbox, { reason: "over-budget", need: e.need, budget: e.budget, detail: e.message });
      }
      this.setActivity(contactId, null, "idle");
      throw e;
    }
    // 在途轮次标记(F12):本轮提交时与游标同一事务删掉;宿主中途退出,重启时据此认出未提交轮次并计 crash_recovery_count
    this.markRunning(contactId, JSON.stringify({ processed: processedNow, inbox: inboxEnd }), focusRoom, lastSeen, inboxEnd);
    let out: Awaited<ReturnType<ContactMind["round"]>>;
    try {
      // 每一轮现场定生效模型(原则 70):用户在失败卡上显式选了备用模型才换,只用于重跑这一批;自动重试永远用原模型(严禁静默换模)
      out = await this.opts.mind({ ...this.contactView(contact), speakingModel: model }).round({ contact: { id: contactId, name: contact.name, speakingModel: model, persona: contact.persona }, request, fresh }, signal);
    } catch (e) {
      this.setActivity(contactId, null, "idle");
      // 宿主中止(停机、发送前撤销)不是失败
      if (signal.aborted || this.closed) return "done";
      return this.onContactFailure(contactId, contact.name, e, { upstream, focusRoom, lastSeen, inboxEnd });
    }
    if (signal.aborted || this.closed) return "done";
    // 模型回了话:这个上游是好的(熔断半开探测成功就恢复,交回被暂停的成员)
    this.upstreamOk(upstream);
    // 发送前检查(AC-31 ④):本轮开始后又来了用户消息,就放弃本轮结果重跑,旧草稿不上屏
    const hasEffects = out.actions.some((a) => a.kind !== "commit");
    if (hasEffects) {
      for (const r of rooms) {
        const newer = loadLog(this.db.store, `room:${r.id}`).log.events.filter((m) => m.seq > (lastSeen[r.id] ?? 0) && m.sender.kind === "user");
        if (newer.length) {
          this.report("stale-round", { contactId, roomId: r.id, newer: newer.map((m) => m.seq) });
          return "stale";
        }
      }
    }
    const stateNote = await this.settleNote(contact, fresh, out, rooms.map((r) => r.id), signal);
    if (signal.aborted || this.closed) return "done";
    const done = this.commitRound(contactId, contact, roundId, fresh, inbox, lastSeen, { actions: out.actions, stateNote });
    this.expireRoundFailures(contactId);
    this.setActivity(contactId, null, "idle");
    await this.runEffects(done.effects);
    return "done";
  }

  /**
   * 群里接活归属(只看元数据,D15.1):来源消息 @ 了别的联系人、没 @ 你,不归你;同一条消息已被别的联系人接手(未取消/失败),
   * 先落盘的拿到(U47 抢答)。返回拒绝原因,可以接则返回 null。必须在事务里调用。
   */
  private claimBlockedTx(contactId: string, src: InboundMessage): string | null {
    const contactsHere = new Set(this.members(src.roomId).filter((m) => m.kind === "contact").map((m) => m.id));
    const mentioned = src.mentions.filter((id) => contactsHere.has(id));
    if (mentioned.length && !mentioned.includes(contactId)) return `这条消息 @ 的是别的联系人,不是你(${src.roomId} #${src.seq})`;
    const taken = listDocs<TaskDoc>(this.db, "task:").find(
      (d) => d.value.roomId === src.roomId && d.value.sourceSeq === src.seq && d.value.task.owner !== null && d.value.task.owner !== contactId && d.value.task.state !== "T10_Cancelled" && d.value.task.state !== "T11_Failed",
    );
    return taken ? `${src.roomId} #${src.seq} 已由联系人 ${taken.value.task.owner} 接手(任务 ${taken.value.task.id})` : null;
  }

  /**
   * 一轮装配超预算的显式失败:在会话里出一张这位联系人的失败卡(说明超了多少、请分批),不截断、不调模型、游标不推进。
   * 这位联系人已有没处理的同类失败卡就只更新它(记下最新一批的位置),不重复出卡。返回 "done":不让注意循环在后台反复重跑,
   * 新输入来了或用户点「重试」才再试;点「跳过本轮」才把这批标为已处理。
   */
  private failRound(contactId: string, roundId: string, roomId: string, lastSeen: Record<string, number>, inbox: { id: number }[], f: { reason: string; need: number; budget: number; detail: string }): RoundStatus {
    const name = this.contactDoc(contactId).value.name;
    const meta = { kind: "round-over-budget", contactId, lastSeen, inboxIds: inbox.map((i) => i.id), reason: f.reason, need: f.need, budget: f.budget };
    const what = f.reason === "recall-over-budget" ? "被引用消息的回读" : "这一轮要读的上下文";
    const body = `${name}${what}需要 ${f.need} 字节,预算 ${f.budget} 字节,超出 ${f.need - f.budget} 字节。没有截断任何内容,也没有调用模型;这批输入还在。请分批:把长内容拆成几条发,或少引用几条;然后点「重试」,或点「跳过本轮」把这批标为已处理。\n${f.detail}`.slice(0, 20000);
    const open = all<CardRow>(this.db, "SELECT * FROM gg_cards WHERE kind = 'failure' AND state = 'open' ORDER BY seq").find((c) => {
      const m = JSON.parse(c.meta) as { kind?: string; contactId?: string };
      return m.kind === "round-over-budget" && m.contactId === contactId;
    });
    this.report("round-failed", { contactId, roundId, reason: f.reason, need: f.need, budget: f.budget });
    if (open) {
      run(this.db, "UPDATE gg_cards SET body = ?, meta = ? WHERE card_id = ?", body, JSON.stringify(meta), open.card_id);
      const m = this.projected(open.room_id).find((x) => x.seq === open.seq);
      if (m) this.bus.emit({ type: "message.updated", message: this.messageView(open.room_id, m) });
    } else {
      const me: Member = { kind: "contact", id: contactId };
      const r = tx(this.db, () =>
        this.appendMessageTx(roomId, me, {
          text: "这一轮没跑成:上下文超预算",
          actionKey: `roundfail:${roundId}`,
          card: {
            card_id: this.newId("card"),
            kind: "failure",
            task_id: null,
            title: "这一轮没跑成:上下文超预算",
            body,
            state: "open",
            actions: JSON.stringify([
              { actionId: "retry", label: "重试", style: "primary" },
              { actionId: "skip", label: "跳过本轮", style: "danger" },
            ]),
            meta: JSON.stringify(meta),
          },
        }),
      );
      this.afterAppend(roomId, r.seq, me);
    }
    this.setActivity(contactId, roomId, "blocked");
    return "done";
  }

  private advanceCursorsTx(contactId: string, lastSeen: Record<string, number>) {
    for (const [roomId, seq] of Object.entries(lastSeen)) {
      run(this.db, "INSERT INTO gg_cursor (contact_id, room_id, processed_seq) VALUES (?, ?, ?) ON CONFLICT (contact_id, room_id) DO UPDATE SET processed_seq = max(processed_seq, excluded.processed_seq)", contactId, roomId, seq);
    }
  }

  /** 校验动作,把本轮全部状态变化放进一个事务;返回事务提交后要执行的副作用。 */
  private commitRound(
    contactId: string,
    contact: ContactDoc,
    roundId: string,
    fresh: Inbound[],
    inbox: { id: number }[],
    lastSeen: Record<string, number>,
    out: { actions: readonly MindAction[]; stateNote: string | null },
  ): { effects: HostEffect[] } {
    const roomIds = new Set(this.roomsOfContact(contactId).map((r) => r.id));
    // 移出中:这个群里的发言、登记承诺与接新活一律拒绝(D05「先禁止新群内接单与发言」)
    const leavingRooms = this.exits.leavingRoomsOf(contactId);
    const freshMsgs = fresh.filter((f): f is InboundMessage => f.kind === "message");
    const effects: HostEffect[] = [];
    const appended: { roomId: string; seq: number }[] = [];
    const touchedTasks = new Set<string>();
    const rejected: { action: MindAction; reason: string }[] = [];
    let hadFailure = false as boolean;
    tx(this.db, () => {
      // 账本:本轮新消息先 receive
      const byRoom = new Map<string, Parameters<typeof applyLedger>[2][]>();
      const push = (roomId: string, c: Parameters<typeof applyLedger>[2]) => byRoom.set(roomId, [...(byRoom.get(roomId) ?? []), c]);
      const ledgerNow = new Map<string, Ledger>();
      for (const m of freshMsgs) {
        const led = ledgerNow.get(m.roomId) ?? this.ledgerOf(contactId, m.roomId).value;
        ledgerNow.set(m.roomId, led);
        if (led.messages.some((x) => x.seq === m.seq)) continue;
        push(m.roomId, {
          type: "receive",
          actionId: `${roundId}:recv:${m.roomId}:${m.seq}`,
          message: { id: `${m.roomId}#${m.seq}`, seq: m.seq, sender: { kind: m.sender.kind === "user" ? "user" : "contact", id: m.sender.id }, text: m.text, taskId: null, replyToSeq: null },
        });
      }
      const dispatchedBySource = new Map<string, string>();
      const proposals = new Map<string, { id: string; taskId: string; text: string }[]>();
      const referenced = new Set<string>();
      const ownCommits: { roomId: string; text: string; taskId: string | null; sourceKey: string }[] = [];
      const replies: { roomId: string; seq: number; text: string }[] = [];
      let i = 0;
      for (const a of out.actions) {
        const actionId = `${roundId}:a${i++}`;
        const reject = (reason: string) => rejected.push({ action: a, reason });
        switch (a.kind) {
          case "reply": {
            if (leavingRooms.has(a.roomId)) { reject(LEAVING_REASON); break; }
            if (!roomIds.has(a.roomId)) { reject("不在这个会话里"); break; }
            if (!a.text.trim()) { reject("空消息"); break; }
            const r = this.appendMessageTx(a.roomId, { kind: "contact", id: contactId }, { text: a.text, actionKey: actionId, replyToSeq: a.replyToSeq, quotedSeqs: a.replyToSeq !== null ? [a.replyToSeq] : [] });
            appended.push({ roomId: a.roomId, seq: r.seq });
            replies.push({ roomId: a.roomId, seq: r.seq, text: a.text });
            if (a.replyToSeq !== null) referenced.add(`${a.roomId}#${a.replyToSeq}`);
            break;
          }
          case "dispatch": {
            if (leavingRooms.has(a.roomId)) { reject(LEAVING_REASON); break; }
            const src = freshMsgs.find((m) => m.roomId === a.roomId && m.seq === a.sourceSeq);
            if (!src) { reject(`来源 ${a.roomId} #${a.sourceSeq} 不是本轮新消息`); break; }
            if (isRewound(this.db, a.roomId, a.sourceSeq)) { reject("来源消息已回退"); break; }
            if (!a.task.trim() || !a.title.trim()) { reject("任务说明为空"); break; }
            const claim = this.claimBlockedTx(contactId, src);
            if (claim) { reject(claim); break; }
            // 用户手动新建的任务:那条消息已经对应一个任务,联系人不能再拿它另建一个(AC-47)
            if (one(this.db, "SELECT 1 FROM gg_cards WHERE room_id = ? AND seq = ? AND task_id IS NOT NULL", a.roomId, a.sourceSeq)) { reject("这条消息已经建过任务"); break; }
            const taskId = this.newId("t");
            const requester = src.sender.kind === "user" ? src.sender.id : this.userId;
            const t0 = newTask(taskId, requester);
            const doc0: TaskDoc = { task: t0, title: a.title.slice(0, 500), roomId: a.roomId, sourceSeq: a.sourceSeq, brief: a.task, createdAt: this.now(), updatedAt: this.now(), result: null };
            putDoc(this.db, `task:${taskId}`, 0, doc0);
            const { effects: eff } = this.stepTaskTx(taskId, { kind: "Claim", by: contactId });
            for (const e of eff) if (e.kind === "spawn-compute") effects.push({ kind: "spawn", taskId, requestId: e.requestId, contactId, model: this.computeModelOf(contact), brief: a.task, roomId: a.roomId });
            const cardId = this.newId("card");
            const r = this.appendMessageTx(a.roomId, { kind: "contact", id: contactId }, {
              text: `接了任务:${a.title}`,
              actionKey: `${actionId}:card`,
              replyToSeq: a.sourceSeq,
              quotedSeqs: [a.sourceSeq],
              card: { card_id: cardId, kind: "task-status", task_id: taskId, title: a.title.slice(0, 200), body: a.task.slice(0, 20000), state: "open", actions: JSON.stringify([{ actionId: "cancel", label: "取消任务", style: "danger" }]), meta: "{}" },
            });
            appended.push({ roomId: a.roomId, seq: r.seq });
            dispatchedBySource.set(`${a.roomId}#${a.sourceSeq}`, taskId);
            referenced.add(`${a.roomId}#${a.sourceSeq}`);
            touchedTasks.add(taskId);
            break;
          }
          case "commit": {
            if (leavingRooms.has(a.roomId)) { reject(LEAVING_REASON); break; }
            const src = freshMsgs.find((m) => m.roomId === a.roomId && m.seq === a.sourceSeq);
            if (!src) { reject(`来源 ${a.roomId} #${a.sourceSeq} 不是本轮新消息`); break; }
            if (isRewound(this.db, a.roomId, a.sourceSeq)) { reject("来源消息已回退"); break; }
            const key = `${a.roomId}#${a.sourceSeq}`;
            if (!src.text.includes(a.text)) {
              // 联系人自己回复里说的「我会做 X」也要进账本(AC-40 ②):原文出自本轮同会话的 reply,就挂到那条回复上
              const own = out.actions.some((x) => x.kind === "reply" && x.roomId === a.roomId && x.text.includes(a.text));
              if (!own) { reject("承诺原文必须出自来源消息或本轮自己的回复"); break; }
              ownCommits.push({ roomId: a.roomId, text: a.text, taskId: a.taskId ?? null, sourceKey: key });
              referenced.add(key);
              break;
            }
            const taskId = a.taskId ?? dispatchedBySource.get(key) ?? `standing-${this.newId("k")}`;
            proposals.set(key, [...(proposals.get(key) ?? []), { id: this.newId("k"), taskId, text: a.text }]);
            referenced.add(key);
            break;
          }
          case "forward": {
            const t = getDoc<TaskDoc>(this.db, `task:${a.taskId}`)?.value;
            if (!t || t.task.owner !== contactId) { reject("不是你的任务"); break; }
            if (!t.task.computeId || TERMINAL.has(t.task.state) || t.task.state === "T9_StopRequested") { reject("任务没有在途 Compute"); break; }
            effects.push({ kind: "resume", taskId: a.taskId, computeId: t.task.computeId, text: a.text });
            break;
          }
          case "deliver": {
            const t = getDoc<TaskDoc>(this.db, `task:${a.taskId}`)?.value;
            if (!t || t.task.owner !== contactId) { reject("不是你的任务"); break; }
            if (t.task.state !== "T3_Running" || !t.task.computeId) { reject(`任务在 ${t.task.state},不能交付`); break; }
            const computeRow = one<{ status: string; result: string | null }>(this.db, "SELECT status, result FROM gg_compute WHERE compute_id = ?", t.task.computeId);
            if (computeRow?.result == null) { reject("Compute 还没完成,不能交付"); break; }
            let commit = `result:${t.task.computeId}`;
            const wsDoc = this.worktrees ? this.workspace(a.taskId) : undefined;
            if (wsDoc && this.worktrees) {
              // 代码任务:把工作区改动提交成候选并钉住 sha,审查与合入都认这个固定提交(W3)
              const pinned = this.worktrees.pin(wsDoc.value, `${t.title}(任务 ${a.taskId})`);
              if (pinned.state !== "W3_Pinned") { reject("上次合入冲突后没有新的改动,先基于最新主线修复"); break; }
              putDoc(this.db, `ws:${a.taskId}`, wsDoc.ver, pinned);
              commit = `git:${pinned.candidateSha}`;
            }
            // 交付是普通消息(AC-56/U98):回复来源消息、@ 提出者,不挂验收卡;用户用普通回复表达通过或修改,由联系人提交 verdict。
            // 审查门(AC-26):还没有跨厂商审查联系人时任务停在 T5,提出者本人回复通过即豁免审查并验收,记为 waived-by-user
            // 可读工件按内容快照进库,交付消息钉住 ref + sha256(AC-04)
            const arts = this.collectArtifacts(a.taskId);
            const r = this.appendMessageTx(t.roomId, { kind: "contact", id: contactId }, {
              text: a.text,
              actionKey: actionId,
              replyToSeq: t.sourceSeq,
              quotedSeqs: [t.sourceSeq],
              mentions: [{ id: t.task.requester, source: "auto" }],
            });
            if (arts.length && !r.duplicate) run(this.db, "INSERT OR IGNORE INTO gg_msg_artifacts (room_id, seq, artifacts) VALUES (?, ?, ?)", t.roomId, r.seq, JSON.stringify(arts));
            this.stepTaskTx(a.taskId, { kind: "SubmitForReview", commit, computeId: t.task.computeId, constraintVer: t.task.constraintVer }, { result: a.text, deliveredSeq: r.seq, artifacts: arts });
            appended.push({ roomId: t.roomId, seq: r.seq });
            touchedTasks.add(a.taskId);
            break;
          }
          case "verdict": {
            // 用户对交付的普通回复由联系人转成结论;宿主只认提出者本人在交付之后、本轮新到的直接消息(AC-28/AC-56,U99 只认本人)
            const d = getDoc<TaskDoc>(this.db, `task:${a.taskId}`)?.value;
            if (!d || d.task.owner !== contactId) { reject(`任务 ${a.taskId} 不存在或不是你的`); break; }
            if (!awaitingUser(d)) { reject(`任务在 ${d.task.state},没有等你确认的交付`); break; }
            const src = freshMsgs.find((m) => m.roomId === d.roomId && m.seq === a.sourceSeq);
            if (!src) { reject(`验收结论的来源 ${d.roomId} #${a.sourceSeq} 不是本轮新消息`); break; }
            if (src.sender.kind !== "user" || src.sender.id !== d.task.requester) { reject(`验收结论的来源 ${d.roomId} #${a.sourceSeq} 不是提出者本人的消息`); break; }
            if (src.seq <= (d.deliveredSeq ?? Number.POSITIVE_INFINITY)) { reject(`验收结论的来源 ${d.roomId} #${a.sourceSeq} 早于这次交付`); break; }
            const wsv = a.verdict === "accept" ? this.workspace(a.taskId)?.value : undefined;
            if (wsv && (wsv.state === "W5_Conflict" || wsv.state === "W4_Integrating")) { reject(wsv.state === "W5_Conflict" ? "上次合入冲突或重验失败,要先退回修复" : "正在合入"); break; }
            effects.push(...this.decideDeliveryTx(a.taskId, a.verdict === "accept" ? "accept" : "reject", src.sender.id, a.feedback?.trim() || src.text));
            referenced.add(`${d.roomId}#${src.seq}`);
            touchedTasks.add(a.taskId);
            break;
          }
          case "stop": {
            const t = getDoc<TaskDoc>(this.db, `task:${a.taskId}`)?.value;
            if (!t || t.task.owner !== contactId) { reject("不是你的任务"); break; }
            const { effects: eff } = this.stepTaskTx(a.taskId, { kind: "Cancel", by: contactId });
            for (const e of eff) if (e.kind === "stop-compute") effects.push({ kind: "stop", taskId: a.taskId, computeId: e.computeId });
            for (const e of eff) if (e.kind === "cancel-spawn") effects.push({ kind: "cancel-spawn", taskId: a.taskId, requestId: e.requestId });
            this.afterCancelTx(a.taskId);
            touchedTasks.add(a.taskId);
            break;
          }
        }
      }
      // 账本:本轮新消息逐条 process(用户消息被动作引用即视为接下;承诺随来源消息登记)
      for (const m of freshMsgs) {
        const key = `${m.roomId}#${m.seq}`;
        const led = ledgerNow.get(m.roomId);
        if (led?.messages.some((x) => x.seq === m.seq && x.handled)) continue;
        push(m.roomId, { type: "process", actionId: `${roundId}:proc:${key}`, seq: m.seq, accepted: m.sender.kind === "user" && referenced.has(key), commitments: m.sender.kind === "user" && referenced.has(key) ? (proposals.get(key) ?? []) : [] });
      }
      // 联系人自己回复里的承诺:把那条回复记进账本,再以它为来源登记
      const byReply = new Map<string, { roomId: string; seq: number; text: string; items: { id: string; taskId: string; text: string }[] }>();
      for (const oc of ownCommits) {
        const rep = replies.find((r) => r.roomId === oc.roomId && r.text.includes(oc.text));
        if (!rep) continue;
        const k = `${rep.roomId}#${rep.seq}`;
        const entry = byReply.get(k) ?? { ...rep, items: [] };
        entry.items.push({ id: this.newId("k"), taskId: oc.taskId ?? dispatchedBySource.get(oc.sourceKey) ?? `standing-${this.newId("k")}`, text: oc.text });
        byReply.set(k, entry);
      }
      for (const [k, e] of byReply) {
        push(e.roomId, { type: "receive", actionId: `${roundId}:recv-own:${k}`, message: { id: k, seq: e.seq, sender: { kind: "contact", id: contactId }, text: e.text, taskId: null, replyToSeq: null } });
        push(e.roomId, { type: "process", actionId: `${roundId}:proc-own:${k}`, seq: e.seq, accepted: true, commitments: e.items });
      }
      for (const [roomId, cmds] of byRoom) this.ledgerTx(contactId, roomId, cmds);
      // 游标、待处理输入、状态笔记与本轮动作同一事务(D15.1)
      this.advanceCursorsTx(contactId, lastSeen);
      for (const ib of inbox) run(this.db, "UPDATE gg_inbox SET consumed = 1 WHERE id = ?", ib.id);
      // 这一批提交成功:在途失败(残留瞬态错误、换模覆盖)清掉,在途轮次标记与 crash_recovery_count 清零(F12「新成功轮次重置计数」)
      hadFailure = run(this.db, "DELETE FROM gg_failures WHERE scope = 'contact' AND subject = ?", contactId) > 0;
      run(this.db, "DELETE FROM gg_round_guard WHERE contact_id = ?", contactId);
      if (out.stateNote !== null) {
        const cur = getDoc<{ text: string }>(this.db, `note:${contactId}`);
        putDoc(this.db, `note:${contactId}`, cur?.ver ?? 0, { text: out.stateNote });
      }
      for (const r of rejected) {
        run(this.db, "INSERT OR REPLACE INTO gg_effects (action_id, kind, payload, status, error, created_at) VALUES (?, ?, ?, 'rejected', ?, ?)", `${roundId}:rej:${rejected.indexOf(r)}`, r.action.kind, JSON.stringify(r.action), r.reason, this.now());
      }
    });
    for (const r of rejected) this.report("action-rejected", { contactId, ...r });
    if (hadFailure) this.emitRetry({ scope: "contact", contactId, taskId: null, roomId: null, state: "cleared", attempt: 0, limit: 0, label: "已恢复" });
    for (const a of appended) this.afterAppend(a.roomId, a.seq, { kind: "contact", id: contactId });
    for (const id of touchedTasks) this.emitTask(id);
    return { effects };
  }

  // ======================= Compute =======================
  /**
   * 适配器按 Harness 建一个、跨任务复用(AC-51):模型每一轮随输入交给它,不按模型另建实例。
   * 没声明按轮换模型能力的旧适配器(一次性进程,模型写在进程环境里)只能按模型分实例,否则换了模型还在用旧模型。
   */
  private adapterFor(harness: string, model: string): ComputeAdapter | null {
    if (!this.opts.compute) return null;
    let a = this.adapters.get(harness) ?? this.adapters.get(`${harness}:${model}`);
    if (!a) {
      a = this.opts.compute(model);
      this.adapters.set(isModelAware(a) ? harness : `${harness}:${model}`, a);
      this.pumps.push(this.pump(a));
    }
    return a;
  }
  private async pump(a: ComputeAdapter) {
    try {
      for await (const ev of a.events()) {
        if (this.closed) break;
        try {
          this.onComputeEvent(ev);
        } catch (e) {
          this.report("compute-event", e);
        }
      }
    } catch (e) {
      if (!this.closed) this.report("compute-pump", e);
    }
  }
  private onComputeEvent(ev: ComputeEvent) {
    const row = one<{ task_id: string; contact_id: string; room_id: string; harness: string }>(this.db, "SELECT task_id, contact_id, room_id, harness FROM gg_compute WHERE compute_id = ?", ev.computeId);
    if (!row) return;
    const at = this.now();
    const summary =
      ev.kind === "started" ? "已开始" : ev.kind === "milestone" ? ev.summary : ev.kind === "blocked" ? `受阻:${ev.needs}。${ev.summary}` : ev.kind === "completed" ? ev.result : ev.kind === "failed" ? `失败:${ev.reason}` : "已停止";
    const stage = ev.kind === "milestone" ? ev.stage : null;
    let taskChanged = false;
    let handled = null as ComputeFailureOutcome | null;
    let recovered = null as string | null;
    tx(this.db, () => {
      run(this.db, "INSERT INTO gg_progress (task_id, compute_id, kind, stage, summary, at) VALUES (?, ?, ?, ?, ?, ?)", row.task_id, ev.computeId, ev.kind, stage, summary, at);
      // AC-29 观测点:Compute 启动后实际加载的 skill/MCP 清单(CLI init 自报),每次启动/续接覆盖为最新一次
      if (ev.kind === "started" && ev.loaded) {
        const cur = getDoc<{ skills: string[]; mcpServers: string[] }>(this.db, `compute-loaded:${ev.computeId}`);
        putDoc(this.db, `compute-loaded:${ev.computeId}`, cur?.ver ?? 0, { skills: [...ev.loaded.skills], mcpServers: [...ev.loaded.mcpServers] });
      }
      const status = ev.kind === "started" || ev.kind === "milestone" ? "running" : ev.kind;
      run(this.db, "UPDATE gg_compute SET status = ?, ended_at = CASE WHEN ? IN ('completed','failed','stopped') THEN ? ELSE ended_at END, result = CASE WHEN ? = 'completed' THEN ? ELSE result END WHERE compute_id = ?", status, ev.kind, at, ev.kind, summary, ev.computeId);
      // 失败轮次容错(AC-36):当前实例执行失败(不是越界违规)先按 A×B 决定续跑、出卡或被熔断暂停,在 T11 之前拦下;决定不了的照旧走 ExecFailed
      if (ev.kind === "failed") handled = this.onComputeFailureTx(row, ev);
      // 续跑后有了真实进展:这一次的失败了结,上游是好的
      if (ev.kind === "milestone" || ev.kind === "blocked" || ev.kind === "completed") {
        const f = this.failureRow("task", row.task_id);
        if (f && f.status === "retrying" && f.compute_id === ev.computeId) {
          run(this.db, "DELETE FROM gg_failures WHERE scope = 'task' AND subject = ?", row.task_id);
          recovered = f.upstream;
        }
      }
      if (ev.kind === "failed" && !handled) {
        const t = this.taskDoc(row.task_id).value.task;
        if (t.computeId === ev.computeId && !TERMINAL.has(t.state) && t.state !== "T9_StopRequested") {
          this.stepTaskTx(row.task_id, { kind: "ExecFailed", computeId: ev.computeId });
          taskChanged = true;
        }
      }
      // 实例停止(stopped)或失败:这只是「停止已请求/这一轮结束」,不是确认停下(AC-23)。确认在 afterRound 里等进程都退出后再做
      if (ev.kind === "failed" || ev.kind === "stopped") this.quota.markStopping(row.task_id);
      // harness 回报的实际模型(AC-51 ⑥):和账本里这个 Compute 最近一次不同、或从没出现过的,追加一条 observed
      const reported = reportedModels(ev);
      if (reported.length) {
        const rec = this.taskDoc(row.task_id).value.models ?? emptyModelRecord;
        const last = rec.attempts.filter((x) => x.computeId === ev.computeId).at(-1);
        const seen = new Set(producerModels(rec));
        for (const m of reported) {
          if (ev.kind === "started" ? last?.model === m : seen.has(m)) continue;
          seen.add(m);
          this.recordTurnTx(row.task_id, ev.computeId, row.harness, m, last?.effort ?? this.settings().defaultEffort, "observed");
          taskChanged = true;
        }
      }
      // 被容错接住的失败不转给联系人(静默退避期间不打断;出卡由宿主机械完成)
      if (ev.kind !== "started" && !handled) {
        const payload: Inbound = { kind: "compute", roomId: row.room_id, taskId: row.task_id, computeId: ev.computeId, signal: ev.kind, summary, at };
        run(this.db, "INSERT INTO gg_inbox (contact_id, room_id, payload, at) VALUES (?, ?, ?, ?)", row.contact_id, row.room_id, JSON.stringify(payload), at);
      }
    });
    if (ev.kind === "failed" || ev.kind === "stopped" || ev.kind === "completed") void this.afterRound(row.task_id, ev.computeId, ev.kind, this.launchEpoch.get(row.task_id) ?? 0);
    const progress: ComputeProgress = { computeId: ev.computeId, taskId: row.task_id, kind: ev.kind, ...(stage ? { stage } : {}), summary, at };
    this.bus.emit({ type: "compute.progress", progress });
    this.emitTask(row.task_id);
    if (taskChanged) this.emitTask(row.task_id);
    if (recovered !== null) {
      this.emitRetry({ scope: "task", contactId: row.contact_id, taskId: row.task_id, roomId: row.room_id, state: "cleared", attempt: 0, limit: 0, label: "已恢复" });
      this.upstreamOk(recovered);
    }
    if (handled) return this.afterComputeFailure(row, handled);
    if (ev.kind !== "started") this.loop.notify(row.contact_id, ev.kind === "milestone" ? "batch" : "now");
  }

  private async runEffects(effects: HostEffect[]) {
    for (const e of effects) {
      try {
        if (e.kind === "spawn") await this.spawn(e);
        else if (e.kind === "resume") await this.resumeCompute(e);
        else if (e.kind === "stop") {
          const a = this.adapterForCompute(e.computeId);
          this.quota.markStopping(e.taskId);
          const r = a ? await a.stop(e.computeId) : { ok: false as const, reason: "没有 Compute 适配器" };
          // 这一轮早已结束(没有在跑的进程,例如交付后取消):没有 stopped 事件会来,直接走停止确认
          if (!r.ok) void this.afterRound(e.taskId, e.computeId, "stopped", this.launchEpoch.get(e.taskId) ?? 0);
        } else if (e.kind === "cancel-spawn") this.cancelQueuedSpawn(e);
        else if (e.kind === "integrate") {
          await this.integrateTask(e.taskId, e.by);
        }
      } catch (err) {
        this.report(`effect-${e.kind}`, err);
      }
    }
  }
  private adapterForCompute(computeId: string): ComputeAdapter | null {
    const row = one<{ harness: string; model: string }>(this.db, "SELECT harness, model FROM gg_compute WHERE compute_id = ?", computeId);
    return row ? this.adapterFor(row.harness, row.model) : null;
  }
  /** 账本追加一条,并让任务状态机的生产模型集合同步(跨厂商审查门禁按它判);在事务里调。 */
  private recordTurnTx(taskId: string, computeId: string, harness: string, model: string, effort: string, reason: AttemptReason) {
    const cur = this.taskDoc(taskId);
    const prev = cur.value.models ?? emptyModelRecord;
    const models = recordAttempt(prev, { computeId, harness, model, effort, reason, at: this.now() });
    if (!isAppendOnly(prev, models)) throw new HostError("internal", "模型账本只能追加");
    let task = cur.value.task;
    if (!task.producerModels.includes(model)) {
      const o = applyTask(task, { kind: "ProducerModelAdded", model, computeId });
      if (o.ok) task = o.task;
      else this.report("producer-model-rejected", { taskId, model, reason: o.reason });
    }
    putDoc(this.db, `task:${taskId}`, cur.ver, { ...cur.value, task, models, updatedAt: this.now() });
  }
  /**
   * 送进 Compute 的每一次后续输入(联系人转达、用户退回重试……)都走这里(AC-51 ①⑤):
   * 按此刻的配置现场解析这一轮的 {model, effort},不兼容先拦;交给适配器在轮边界切换;切换失败这一轮不算发出,不退回旧模型。
   */
  private async computeTurn(e: { taskId: string; computeId: string; text: string }, reason: AttemptReason = "turn"): Promise<boolean> {
    const row = one<{ contact_id: string; room_id: string; harness: string; model: string }>(this.db, "SELECT contact_id, room_id, harness, model FROM gg_compute WHERE compute_id = ?", e.computeId);
    const a = row ? this.adapterFor(row.harness, row.model) : null;
    if (!row || !a) {
      this.report("resume-failed", { ...e, reason: "没有 Compute 适配器" });
      return false;
    }
    const owner = getDoc<ContactDoc>(this.db, `contact:${row.contact_id}`)?.value;
    const base = owner ? this.resolveComputeFor(owner) : null;
    // AC-36 [换模型重试]:用户在失败卡上显式选的备用模型只用于重跑这一批(记在在途失败里,成功后清掉),其余照联系人配置
    const override = this.failureRow("task", e.taskId)?.model_override ?? null;
    const resolved = base && override ? { ...base, model: override } : base;
    if (resolved) {
      if (resolved.harness !== row.harness) {
        return this.turnRefused(e.taskId, e.computeId, row, `这个 Compute 跑在 ${row.harness} 上,联系人已改用 ${resolved.harness};换 Harness 要在新 Harness 上开新会话(随 Codex 接入实现),这一轮没有发出`);
      }
      const chk = modelConfig.checkCompute(this.caps(), resolved);
      if (!chk.ok) { this.turnRefused(e.taskId, e.computeId, row, chk.reason); return false; }
      if (!isModelAware(a) && resolved.model !== row.model) {
        return this.turnRefused(e.taskId, e.computeId, row, `这个 Compute 的适配器不支持会话内换模型,仍是启动时的 ${row.model},联系人已改用 ${resolved.model};这一轮没有发出,不沿用旧模型继续跑`);
      }
    }
    const turn: TurnModel | undefined = resolved ? { model: resolved.model, effort: resolved.effort } : undefined;
    const r = await (a.resume as (id: string, text: string, turn?: TurnModel) => Promise<{ ok: true } | TurnRefusal>)(e.computeId, e.text, turn);
    if (!r.ok) {
      if (r.code === "model-switch-failed") return this.turnRefused(e.taskId, e.computeId, row, `换模型没成功:${r.reason}。这一轮没有发出;可以单独指定一个兼容的模型,或更换支持该模型的 Harness`);
      this.report("resume-failed", { ...e, reason: r.reason });
      return false;
    }
    if (resolved) {
      tx(this.db, () => this.recordTurnTx(e.taskId, e.computeId, row.harness, resolved.model, resolved.effort, reason));
      this.emitTask(e.taskId);
    }
    return true;
  }
  /** 这一轮没送进 Compute:原因记进进度,并告诉联系人(由它在聊天里给用户两条修复路径)。 */
  private turnRefused(taskId: string, computeId: string, row: { contact_id: string; room_id: string }, why: string): false {
    const at = this.now();
    this.report("turn-refused", { taskId, computeId, why });
    tx(this.db, () => {
      run(this.db, "INSERT INTO gg_progress (task_id, compute_id, kind, stage, summary, at) VALUES (?, ?, 'blocked', 'model', ?, ?)", taskId, computeId, why, at);
      const payload: Inbound = { kind: "compute", roomId: row.room_id, taskId, computeId, signal: "blocked", summary: why, at };
      run(this.db, "INSERT INTO gg_inbox (contact_id, room_id, payload, at) VALUES (?, ?, ?, ?)", row.contact_id, row.room_id, JSON.stringify(payload), at);
    });
    this.bus.emit({ type: "compute.progress", progress: { computeId, taskId, kind: "blocked", stage: "model", summary: why, at } });
    this.emitTask(taskId);
    this.loop.notify(row.contact_id, "now");
    return false;
  }
  /** 申请槽位(AC-23):拿到就返回 true;没拿到就把这次启动/续接挂起排队,返回 false */
  private takeSlot(e: Extract<HostEffect, { kind: "spawn" | "resume" }>, contactId: string, roomId: string): boolean {
    const isGroup = one<{ kind: string }>(this.db, "SELECT kind FROM gg_rooms WHERE id = ?", roomId)?.kind === "group";
    const got = this.quota.acquire({ taskId: e.taskId, contactId, roomId, isGroup });
    if ("granted" in got) return true;
    this.pendingLaunch.set(e.taskId, e);
    this.emitTask(e.taskId);
    return false;
  }
  /** 归还这个任务的槽位,把空出来的给排队的下一个(们) */
  private giveBack(taskId: string) {
    const lease = this.quota.leaseOf(taskId);
    if (!lease) return;
    const { granted } = this.quota.release(lease.leaseId);
    for (const g of granted) {
      const next = this.pendingLaunch.get(g.taskId);
      this.pendingLaunch.delete(g.taskId);
      if (next) void this.runEffects([next]);
      else this.quota.release(g.leaseId);
    }
  }
  /** 一轮结束后的收尾(AC-23):等进程真的都退出(停止/失败时找出它启动的子进程一并关掉)再确认停止、归还槽位。
   *  epoch 是这一轮开始时的序号;期间任务又起了新一轮(续接),这次收尾就不动槽位 */
  private async afterRound(taskId: string, computeId: string, kind: "failed" | "stopped" | "completed", epoch: number) {
    const a = this.adapterForCompute(computeId);
    let ok = true;
    let why = "";
    if (a) {
      if (kind !== "completed" && a.quiesce) {
        const q = await a.quiesce(computeId);
        if (!q.ok) { ok = false; why = `${q.reason}${q.remaining.length ? `(pid ${q.remaining.join(",")})` : ""}`; }
      } else await a.settled(computeId);
    }
    if (this.closed) return;
    if (!ok) {
      this.stopUnconfirmed.set(taskId, `停止未确认:${why}`);
      this.report("stop-unconfirmed", { taskId, computeId, reason: why });
      this.emitTask(taskId);
      return;
    }
    this.stopUnconfirmed.delete(taskId);
    tx(this.db, () => {
      const t = this.taskDoc(taskId).value.task;
      if (t.state === "T9_StopRequested" && (t.computeId === computeId || t.orphans.includes(computeId))) this.stepTaskTx(taskId, { kind: "StoppedConfirmed", taskId, computeId });
    });
    // 这一轮的进程都已退出:槽位归还;任务之后续接同一实例(退回、回答问题)时重新申请
    if ((this.launchEpoch.get(taskId) ?? 0) === epoch) this.giveBack(taskId);
    this.emitTask(taskId);
  }
  /** 取消还在排队(或启动没成功)的启动请求:不再排队,当场确认撤销 */
  private cancelQueuedSpawn(e: Extract<HostEffect, { kind: "cancel-spawn" }>) {
    const queued = this.pendingLaunch.get(e.taskId);
    if (queued?.kind !== "spawn" || queued.requestId !== e.requestId) return;
    this.pendingLaunch.delete(e.taskId);
    this.quota.cancelWait(e.taskId);
    tx(this.db, () => {
      this.stepTaskTx(e.taskId, { kind: "StoppedConfirmed", taskId: e.taskId, requestId: e.requestId });
    });
    this.emitTask(e.taskId);
  }
  private async resumeCompute(e: Extract<HostEffect, { kind: "resume" }>) {
    const row = one<{ contact_id: string; room_id: string }>(this.db, "SELECT contact_id, room_id FROM gg_compute WHERE compute_id = ?", e.computeId);
    if (!row) return this.report("resume-failed", { ...e, reason: "没有这个 Compute" });
    if (!this.takeSlot(e, row.contact_id, row.room_id)) return;
    // 续接这一轮(AC-51 现场解析生效模型在 computeTurn 里);没送进 Compute 就当场归还槽位
    if (await this.computeTurn(e)) this.launchEpoch.set(e.taskId, (this.launchEpoch.get(e.taskId) ?? 0) + 1);
    else this.giveBack(e.taskId);
  }
  private async spawn(e: Extract<HostEffect, { kind: "spawn" }>) {
    if (!this.takeSlot(e, e.contactId, e.roomId)) return;
    const fail = (reason: string) => {
      // 没起来:没有进程要等,槽位当场归还
      this.giveBack(e.taskId);
      tx(this.db, () => {
        const { effects: eff } = this.stepTaskTx(e.taskId, { kind: "ExecFailed", requestId: e.requestId });
        // 启动本来就没成功:撤销请求当场确认(没有实例可停),任务落到 T11
        for (const x of eff) if (x.kind === "cancel-spawn") this.stepTaskTx(e.taskId, { kind: "StoppedConfirmed", taskId: e.taskId, requestId: x.requestId });
        // 启动途中任务已被取消(T9 等的正是这次启动):启动失败即确认撤销,落到 T10
        const cur = this.taskDoc(e.taskId).value.task;
        if (cur.state === "T9_StopRequested" && cur.launch?.requestId === e.requestId) this.stepTaskTx(e.taskId, { kind: "StoppedConfirmed", taskId: e.taskId, requestId: e.requestId });
        const payload: Inbound = { kind: "compute", roomId: e.roomId, taskId: e.taskId, computeId: "-", signal: "failed", summary: `Compute 没起来:${reason}`, at: this.now() };
        run(this.db, "INSERT INTO gg_inbox (contact_id, room_id, payload, at) VALUES (?, ?, ?, ?)", e.contactId, e.roomId, JSON.stringify(payload), this.now());
      });
      this.emitTask(e.taskId);
      this.loop.notify(e.contactId, "now");
    };
    // 启动前(AC-32 ② 第三个时机):按此刻配置现场解析生效值,不兼容就不起 Compute,不退回 Harness 默认模型
    const owner = getDoc<ContactDoc>(this.db, `contact:${e.contactId}`)?.value;
    const resolved = owner ? this.resolveComputeFor(owner) : null;
    if (resolved) {
      const chk = modelConfig.checkCompute(this.caps(), resolved);
      if (!chk.ok) {
        this.report("model-incompatible", { taskId: e.taskId, contactId: e.contactId, harness: resolved.harness, model: resolved.model, fixes: chk.fixes });
        return fail(chk.reason);
      }
    }
    const harness = resolved?.harness ?? "claude-code";
    const model = resolved?.model ?? e.model;
    const adapter = this.adapterFor(harness, model);
    if (!adapter) return fail("宿主没有配置 Compute 适配器");
    let cwd: string | undefined;
    try {
      cwd = this.computeCwdFor(e.taskId);
    } catch (err) {
      return fail(`工作目录准备失败:${err instanceof Error ? err.message : String(err)}`);
    }
    const tools = [...(this.opts.computeTools ?? DEFAULT_COMPUTE_TOOLS)];
    // 首轮就带生效模型(AC-51 ①);只给声明了按轮换模型能力的适配器(旧的一次性适配器只收 cwd/handoff)
    const modelAware = isModelAware(adapter);
    // 能力默认隔离加白名单(AC-29):只把联系人勾选的 skill/MCP 放进它的专属运行目录;缺项不启动
    const contact = getDoc<ContactDoc>(this.db, `contact:${e.contactId}`)?.value;
    const picked = (contact?.computeAssets ?? []).filter((x) => x.kind !== "script");
    const prep = this.capabilities.prepare(e.contactId, contact?.harness ?? "claude-code", contact?.computeAssets ?? []);
    if (!prep.ok) return fail(`勾选的能力不可用:${prep.missing.join("、")}`);
    // 一次性适配器收专属配置目录与勾选能力;声明能力的适配器(常驻)要显式声明 isolation 才收。
    // 不收的适配器:勾选了 skill/MCP 就明确失败,不带着缺项启动
    const isoOk = !modelAware || (adapter as { capabilities?: { isolation?: unknown } }).capabilities?.isolation === true;
    if (!isoOk && picked.length) return fail(`这个 Compute 适配器还不支持勾选的 skill/MCP(${picked.map((x) => x.name).join("、")}),不带着缺项启动`);
    const iso = isoOk ? { configDir: prep.home.configDir, pluginDirs: [...prep.home.pluginDirs], mcpServers: prep.home.mcpServers } : {};
    const spawnOpts = { ...(cwd ? { cwd } : {}), ...(modelAware ? { model, ...(resolved ? { effort: resolved.effort } : {}) } : {}), ...iso };
    const r = await adapter.spawn({ task: e.brief, rules: [], tools, credentialRefs: [], placement: "local" }, spawnOpts);
    if (!r.ok) return fail(r.reason);
    const late: string[] = [];
    this.launchEpoch.set(e.taskId, (this.launchEpoch.get(e.taskId) ?? 0) + 1);
    tx(this.db, () => {
      run(this.db, "INSERT INTO gg_compute (compute_id, task_id, contact_id, room_id, harness, model, status, started_at) VALUES (?, ?, ?, ?, ?, ?, 'starting', ?)", r.computeId, e.taskId, e.contactId, e.roomId, harness, model, this.now());
      // 首次启动写入不可变快照,账本追加一条 start(AC-32 ④)
      const prev = this.taskDoc(e.taskId).value.models ?? emptyModelRecord;
      const models = recordAttempt(prev, { computeId: r.computeId, harness, model, effort: resolved?.effort ?? this.settings().defaultEffort, reason: "start", at: this.now() });
      if (!isAppendOnly(prev, models)) throw new HostError("internal", "模型账本只能追加");
      const { effects: eff } = this.stepTaskTx(e.taskId, { kind: "Dispatch", computeId: r.computeId, model, requestId: e.requestId }, { models });
      for (const x of eff) if (x.kind === "stop-compute") late.push(x.computeId);
    });
    this.emitTask(e.taskId);
    // 启动途中任务已被取消(如私聊 rewind):实例一上线就停,等它回报 stopped 再落 T10,不让它带着作废的请求跑下去
    for (const id of late) await adapter.stop(id);
  }

  // ======================= 卡片与验收 =======================
  /** 用户点卡片按钮;以对话消息形式记录(决策是共享上下文)。 */
  /** 这位联系人一轮跑成了:之前那批已一并处理,没处理的超预算失败卡收口为过期。 */
  private expireRoundFailures(contactId: string) {
    for (const c of all<CardRow>(this.db, "SELECT * FROM gg_cards WHERE kind = 'failure' AND state = 'open'")) {
      const m = JSON.parse(c.meta) as { kind?: string; contactId?: string };
      if (m.kind !== "round-over-budget" || m.contactId !== contactId) continue;
      run(this.db, "UPDATE gg_cards SET state = 'expired' WHERE card_id = ? AND state = 'open'", c.card_id);
      const msg = this.projected(c.room_id).find((x) => x.seq === c.seq);
      if (msg) this.bus.emit({ type: "message.updated", message: this.messageView(c.room_id, msg) });
    }
  }
  /** 整轮超预算失败卡:「跳过本轮」把那一批标为已处理(推进游标、消费收件箱),由用户显式决定;「重试」不改状态,回复消息会叫醒联系人再试。 */
  private applyRoundFailureTx(card: CardRow, actionId: string) {
    const meta = JSON.parse(card.meta) as { kind?: string; contactId?: string; lastSeen?: Record<string, number>; inboxIds?: number[] };
    if (meta.kind !== "round-over-budget" || !meta.contactId || actionId !== "skip") return;
    this.advanceCursorsTx(meta.contactId, meta.lastSeen ?? {});
    for (const id of meta.inboxIds ?? []) run(this.db, "UPDATE gg_inbox SET consumed = 1 WHERE id = ?", id);
  }
  cardAct(input: { roomId: string; seq: number; cardId: string; actionId: string; clientActionId: string; text?: string }): MessageView {
    const card = one<CardRow>(this.db, "SELECT * FROM gg_cards WHERE card_id = ?", input.cardId);
    if (!card || card.room_id !== input.roomId || card.seq !== input.seq) throw new HostError("not_found", "卡片不存在");
    const actions = JSON.parse(card.actions) as { actionId: string; label: string }[];
    const act = actions.find((a) => a.actionId === input.actionId);
    if (!act) throw new HostError("invalid_params", `卡片没有动作 ${input.actionId}`);
    // 可恢复失败卡(AC-36 A27-05):领取规则与 kernel claimFailureCard 一致,过期代次、未授权、静默换模在领取之前就拒绝
    // (超预算失败卡 round-over-budget 另走 applyRoundFailureTx)
    const failure = card.kind === "failure" && isRetryCardMeta(card.meta) ? this.checkFailureClaim(card, input.actionId) : null;
    // CAS 领取:open → claimed,连点只有第一次生效(AC-36 ⑤)
    if (run(this.db, "UPDATE gg_cards SET state = 'claimed' WHERE card_id = ? AND state = 'open'", input.cardId) !== 1) throw new HostError("conflict", "这张卡已经处理过了");
    const me: Member = { kind: "user", id: this.userId };
    let msgSeq = 0;
    const effects: HostEffect[] = [];
    let afterFailure = null as (() => void) | null;
    try {
      tx(this.db, () => {
        const text = input.text?.trim() ? `${act.label}:${input.text.trim()}` : act.label;
        msgSeq = this.appendMessageTx(card.room_id, me, { text, actionKey: `user:${input.clientActionId}`, clientActionId: input.clientActionId, replyToSeq: card.seq, quotedSeqs: [card.seq] }).seq;
        if (failure) afterFailure = this.applyFailureDecisionTx(failure);
        else {
          if (card.task_id) effects.push(...this.applyCardDecisionTx(card, input.actionId, input.text ?? ""));
          if (card.kind === "failure") this.applyRoundFailureTx(card, input.actionId);
        }
        run(this.db, "UPDATE gg_cards SET state = 'done' WHERE card_id = ?", input.cardId);
      });
    } catch (e) {
      run(this.db, "UPDATE gg_cards SET state = 'open' WHERE card_id = ? AND state = 'claimed'", input.cardId);
      throw e;
    }
    this.markRead(card.room_id, me, msgSeq);
    afterFailure?.();
    this.afterAppend(card.room_id, msgSeq, me);
    if (card.task_id) this.emitTask(card.task_id);
    const updated = this.projected(card.room_id).find((m) => m.seq === card.seq);
    if (updated) this.bus.emit({ type: "message.updated", message: this.messageView(card.room_id, updated) });
    void this.runEffects(effects);
    return this.messageView(card.room_id, this.projected(card.room_id).find((m) => m.seq === msgSeq)!);
  }
  private applyCardDecisionTx(card: CardRow, actionId: string, note: string): HostEffect[] {
    const taskId = card.task_id!;
    const t = this.taskDoc(taskId).value.task;
    const effects: HostEffect[] = [];
    if (card.kind === "task-status" && actionId === "cancel") {
      const { effects: eff } = this.stepTaskTx(taskId, { kind: "Cancel", by: this.userId });
      for (const e of eff) if (e.kind === "stop-compute") effects.push({ kind: "stop", taskId, computeId: e.computeId });
      for (const e of eff) if (e.kind === "cancel-spawn") effects.push({ kind: "cancel-spawn", taskId, requestId: e.requestId });
      this.afterCancelTx(taskId);
      return effects;
    }
    if (card.kind !== "delivery" || (actionId !== "accept" && actionId !== "reject")) return effects;
    if (!["T5_InReview", "T8a_Delivered"].includes(t.state)) return effects;
    return this.decideDeliveryTx(taskId, actionId, this.userId, note || "请继续修改");
  }
  /**
   * 对一件等用户确认的交付下结论(交付卡、显式入口、联系人转来的普通回复都走这里)。必须在事务里调用。
   * 通过:T5(还没有审查人)= 提出者本人豁免审查并验收,记 waived-by-user;T8a 直接验收;了结承诺、任务卡收口。
   * 退回:原 Compute 实例还在(没停、没失败)就恢复原实例并带上意见;不可恢复才携交接新开(AC-28 A/B)。
   */
  private decideDeliveryTx(taskId: string, decision: "accept" | "reject", by: string, note: string): HostEffect[] {
    const doc = this.taskDoc(taskId).value;
    const t = doc.task;
    const effects: HostEffect[] = [];
    if (decision === "accept") {
      // 代码任务:审查(豁免)通过后先受控合入,合入成功才记验收(R-Worktree W3 → W4)
      const code = this.acceptCodeTaskTx(taskId, by);
      if (code) return code;
      if (t.state === "T5_InReview") {
        const owner = t.owner ? getDoc<ContactDoc>(this.db, `contact:${t.owner}`)?.value : undefined;
        const { effects: eff } = this.stepTaskTx(taskId, { kind: "Review", reviewerId: by, reviewerModel: owner?.speakingModel ?? this.settings().defaultSpeakingModel, round: t.reviewRound, commit: t.reviewedCommit ?? "", constraintVer: t.constraintVer, waiverBy: by, verdict: "approve" });
        const send = eff.find((e) => e.kind === "send-card");
        if (send && send.kind === "send-card") {
          this.stepTaskTx(taskId, { kind: "DeliveredCard", taskId, deliveryRound: send.deliveryRound, commit: send.commit });
          const t2 = this.taskDoc(taskId).value.task;
          this.stepTaskTx(taskId, { kind: "UserAccept", taskId, by, deliveryRound: t2.delivery!.round, commit: t2.delivery!.commit });
        }
      } else if (t.state === "T8a_Delivered" && t.delivery) {
        this.stepTaskTx(taskId, { kind: "UserAccept", taskId, by, deliveryRound: t.delivery.round, commit: t.delivery.commit });
      } else throw new HostError("conflict", `任务在 ${t.state},没有待确认的交付`);
      this.closeCommitmentsTx(t.owner, doc.roomId, taskId, "done");
      run(this.db, "UPDATE gg_cards SET state = 'done' WHERE task_id = ? AND kind = 'task-status' AND state = 'open'", taskId);
      return effects;
    }
    const resumable = this.computeResumable(t.computeId);
    const prev = t.computeId ? (one<{ result: string | null }>(this.db, "SELECT result FROM gg_compute WHERE compute_id = ?", t.computeId)?.result ?? null) : null;
    let eff: { kind: string; computeId?: string; requestId?: string }[];
    if (t.state === "T5_InReview") eff = this.stepTaskTx(taskId, { kind: "Amend", by, computeResumable: resumable }).effects;
    else if (t.state === "T8a_Delivered" && t.delivery) eff = this.stepTaskTx(taskId, { kind: "UserReject", taskId, by, computeResumable: resumable, deliveryRound: t.delivery.round, commit: t.delivery.commit }).effects;
    else throw new HostError("conflict", `任务在 ${t.state},没有待确认的交付`);
    for (const e of eff) {
      if ((e.kind === "resume-compute" || e.kind === "update-constraints") && e.computeId) {
        // 恢复原实例:旧结果作废,等它这次的完成事件才能再交付
        run(this.db, "UPDATE gg_compute SET status = 'running', result = NULL, ended_at = NULL WHERE compute_id = ?", e.computeId);
        effects.push({ kind: "resume", taskId, computeId: e.computeId, text: `用户退回:${note}` });
      } else if (e.kind === "spawn-compute" && e.requestId && t.owner) {
        const owner = this.contactDoc(t.owner).value;
        const brief = `${doc.brief}\n\n【交接】上一个 Compute 已结束,这是返工。\n上次结果:${prev ?? "(无)"}\n用户退回意见:${note}`;
        effects.push({ kind: "spawn", taskId, requestId: e.requestId, contactId: t.owner, model: this.computeModelOf(owner), brief, roomId: doc.roomId });
      }
    }
    return effects;
  }
  /** 原 Compute 实例还能不能恢复:实例记录在、没停也没失败、宿主有适配器。 */
  private computeResumable(computeId: string | null): boolean {
    if (!computeId || !this.opts.compute) return false;
    const row = one<{ status: string }>(this.db, "SELECT status FROM gg_compute WHERE compute_id = ?", computeId);
    return !!row && row.status !== "stopped" && row.status !== "failed";
  }
  private closeCommitmentsTx(contactId: string | null, roomId: string, taskId: string, outcome: "done") {
    if (!contactId) return;
    const led = this.ledgerOf(contactId, roomId).value;
    const cmds = led.commitments
      .filter((c) => c.taskId === taskId && c.status === "active")
      .map((c) => ({ type: "close" as const, actionId: `close:${c.id}`, commitmentId: c.id, taskId, actor: { kind: "contact" as const, id: contactId }, roundId: `accept:${taskId}`, outcome, artifact: `task:${taskId}/result`, detail: null }));
    this.ledgerTx(contactId, roomId, cmds);
  }

  // ======================= 失败轮次容错(AC-36) =======================
  // 联系人一轮或任务的 Compute 失败之后怎么办(是否失败、什么原因由 kernel 的失败分类器判):
  //   A1×(B0|B1) 静默指数退避(状态行「重连中 k/N」,不出卡);耗尽、A2/A3、B2 由宿主机械出 1 张原位可恢复失败卡;
  //   同一上游上不同成员连续失败或 A2 触发共享熔断:暂停后台重试,全群合并 1 张群级卡,半开探测成功后交回成员续跑(A2 只能由用户发起探测)。
  //   失败卡按钮走 cards.act 的 CAS 领取;[跳过本轮]只把游标推到失败批次末尾,失败期间新到的消息留给下一轮。
  private upstreamKey(model: string): string {
    try {
      const k = this.opts.upstreamOf?.(model);
      return typeof k === "string" && k ? k : model;
    } catch {
      return model;
    }
  }
  private failureRow(scope: "contact" | "task", subject: string): FailureRow | undefined {
    return one<FailureRow>(this.db, "SELECT * FROM gg_failures WHERE scope = ? AND subject = ?", scope, subject);
  }
  private upsertFailureTx(f: Omit<FailureRow, "created_at" | "updated_at">) {
    const at = this.now();
    run(
      this.db,
      `INSERT INTO gg_failures (scope, subject, contact_id, status, heal, effect, reason_class, label, fix, raw, attempts, attempt_seq, batch_end, inbox_end, room_id, upstream, card_id, model_override, compute_id, delivery_unknown, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (scope, subject) DO UPDATE SET contact_id = excluded.contact_id, status = excluded.status, heal = excluded.heal, effect = excluded.effect,
         reason_class = excluded.reason_class, label = excluded.label, fix = excluded.fix, raw = excluded.raw, attempts = excluded.attempts, attempt_seq = excluded.attempt_seq,
         batch_end = excluded.batch_end, inbox_end = excluded.inbox_end, room_id = excluded.room_id, upstream = excluded.upstream, card_id = excluded.card_id,
         model_override = excluded.model_override, compute_id = excluded.compute_id, delivery_unknown = excluded.delivery_unknown, updated_at = excluded.updated_at`,
      f.scope, f.subject, f.contact_id, f.status, f.heal, f.effect, f.reason_class, f.label, f.fix, f.raw.slice(0, 20000), f.attempts, f.attempt_seq, f.batch_end, f.inbox_end,
      f.room_id, f.upstream, f.card_id, f.model_override, f.compute_id, f.delivery_unknown, at, at,
    );
  }
  private breakerRow(upstream: string): { state: BreakerState; card_id: string | null; room_id: string | null } {
    const r = one<{ state: string; card_id: string | null; room_id: string | null }>(this.db, "SELECT state, card_id, room_id FROM gg_breakers WHERE upstream = ?", upstream);
    return r ? { state: JSON.parse(r.state) as BreakerState, card_id: r.card_id, room_id: r.room_id } : { state: BREAKER_CLOSED, card_id: null, room_id: null };
  }
  /** 写熔断状态;card 给了就一并改群级卡指针(null 表示当前没有可点的群级卡)。 */
  private saveBreaker(upstream: string, state: BreakerState, card?: { card_id: string | null; room_id: string | null }) {
    const keep = card ? 0 : 1;
    run(
      this.db,
      `INSERT INTO gg_breakers (upstream, state, card_id, room_id, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (upstream) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at,
         card_id = CASE WHEN ? = 1 THEN gg_breakers.card_id ELSE excluded.card_id END, room_id = CASE WHEN ? = 1 THEN gg_breakers.room_id ELSE excluded.room_id END`,
      upstream, JSON.stringify(state), card?.card_id ?? null, card?.room_id ?? null, this.now(), keep, keep,
    );
  }
  /** 共享熔断放行(F10):关闭放行;打开时暂停;冷却到期或用户在群级卡上点了重试才放 1 个半开探测,放行的探测记进状态。 */
  private admitUpstream(upstream: string, priority: "interactive" | "background"): boolean {
    const b = this.breakerRow(upstream);
    if (b.state.status === "closed") return true;
    const r = breakerAdmit(b.state, { nowMs: this.clock(), priority, manual: this.manualProbe.has(upstream) }, this.breakerPolicy);
    if (!r.ok) {
      this.report("breaker-state-invalid", { upstream, reason: r.reason });
      return true;
    }
    if (r.admit) {
      this.saveBreaker(upstream, r.state);
      this.manualProbe.delete(upstream);
    }
    return r.admit;
  }
  /** 这个上游有一次成功:熔断回到关闭;从打开/半开恢复时群级卡作废(自动恢复抢先,之后的点击被拒),被暂停的成员续跑。 */
  private upstreamOk(upstream: string) {
    const b = this.breakerRow(upstream);
    if (b.state.status === "closed" && b.state.failures === 0) return;
    const r = breakerSuccess(b.state);
    if (!r.ok) return;
    const contacts: string[] = [];
    const tasks: string[] = [];
    tx(this.db, () => {
      this.saveBreaker(upstream, r.state, { card_id: null, room_id: null });
      if (!r.recovered) return;
      if (b.card_id) run(this.db, "UPDATE gg_cards SET state = 'expired' WHERE card_id = ? AND state = 'open'", b.card_id);
      for (const m of r.resume) {
        const [kind, id] = splitMember(m);
        if (kind === "contact" && run(this.db, "DELETE FROM gg_failures WHERE scope = 'contact' AND subject = ? AND status = 'paused'", id)) contacts.push(id);
        if (kind === "task" && run(this.db, "UPDATE gg_failures SET status = 'retrying', attempts = 0, updated_at = ? WHERE scope = 'task' AND subject = ? AND status = 'paused'", this.now(), id)) tasks.push(id);
      }
    });
    this.clearHostTimer(`breaker:${upstream}`);
    this.manualProbe.delete(upstream);
    if (!r.recovered) return;
    if (b.card_id) this.emitCardUpdated(b.card_id);
    for (const id of contacts) {
      this.emitRetry({ scope: "contact", contactId: id, taskId: null, roomId: null, state: "cleared", attempt: 0, limit: 0, label: "已恢复" });
      this.loop.notify(id, "now");
    }
    for (const id of tasks) this.scheduleComputeResume(id, 0);
  }
  /** 被打开的共享熔断挡住:记成暂停的成员(恢复后续跑),不调模型、不出自己的卡。batchEnd 为 null 时沿用已有失败记录的失败批次。 */
  private pauseBehindBreaker(scope: "contact" | "task", subject: string, contactId: string, upstream: string, roomId: string | null, batchEnd: Record<string, number> | null, inboxEnd: number) {
    const member = `${scope}:${subject}`;
    tx(this.db, () => {
      const b = this.breakerRow(upstream);
      if (!b.state.members.includes(member)) this.saveBreaker(upstream, { ...b.state, members: [...b.state.members, member] });
      const f = this.failureRow(scope, subject);
      if (f) run(this.db, "UPDATE gg_failures SET status = 'paused', updated_at = ? WHERE scope = ? AND subject = ?", this.now(), scope, subject);
      else
        this.upsertFailureTx({
          scope, subject, contact_id: contactId, status: "paused", heal: "A1", effect: "B0", reason_class: "upstream_unavailable", label: b.state.reason ?? "上游暂停", fix: "", raw: "",
          attempts: 0, attempt_seq: 0, batch_end: JSON.stringify(batchEnd ?? {}), inbox_end: inboxEnd, room_id: roomId, upstream, card_id: null, model_override: null, compute_id: null, delivery_unknown: 0,
        });
    });
    this.emitRetry({ scope, contactId, taskId: scope === "task" ? subject : null, roomId, state: "paused", attempt: 0, limit: 0, label: "共用的上游暂停中" });
  }
  private setHostTimer(key: string, ms: number, fn: () => void) {
    this.clearHostTimer(key);
    if (this.closed) return;
    this.hostTimers.set(
      key,
      this.timersApi.set(() => {
        this.hostTimers.delete(key);
        if (!this.closed) fn();
      }, Math.max(0, ms)),
    );
  }
  private clearHostTimer(key: string) {
    const h = this.hostTimers.get(key);
    if (h !== undefined) this.timersApi.clear(h);
    this.hostTimers.delete(key);
  }
  /** 熔断冷却到期放 1 个半开探测(A2 打开的不自动探测,严禁对 403 自动重试)。 */
  private armBreakerProbe(upstream: string) {
    const key = `breaker:${upstream}`;
    if (this.closed || this.hostTimers.has(key)) return;
    const b = this.breakerRow(upstream);
    if (b.state.status === "closed" || b.state.manualOnly) return;
    const wait = (b.state.openedAt ?? this.clock()) + this.breakerPolicy.cooldownMs - this.clock();
    this.setHostTimer(key, wait, () => this.probeMembers(upstream));
  }
  /** 叫醒被暂停的成员:第一个拿到半开探测,其余仍被挡住;探测失败会重新打开并再排一次探测。 */
  private probeMembers(upstream: string) {
    const b = this.breakerRow(upstream);
    if (b.state.status === "closed") return;
    for (const m of b.state.members) {
      const [kind, id] = splitMember(m);
      if (kind === "contact") this.loop.notify(id, "now");
      if (kind === "task" && run(this.db, "UPDATE gg_failures SET status = 'retrying', updated_at = ? WHERE scope = 'task' AND subject = ? AND status = 'paused'", this.now(), id)) this.scheduleComputeResume(id, 0);
    }
  }
  private emitRetry(e: { scope: "contact" | "task"; contactId: string; taskId: string | null; roomId: string | null; state: "retrying" | "card" | "paused" | "cleared"; attempt: number; limit: number; label: string }) {
    this.bus.emit({ type: "retry.updated", ...e, label: e.label.slice(0, 200) });
  }
  private emitCardUpdated(cardId: string) {
    const c = one<{ room_id: string; seq: number }>(this.db, "SELECT room_id, seq FROM gg_cards WHERE card_id = ?", cardId);
    if (!c) return;
    const m = this.projected(c.room_id).find((x) => x.seq === c.seq);
    if (m) this.bus.emit({ type: "message.updated", message: this.messageView(c.room_id, m) });
  }
  /**
   * 失败原文 → 原因类别(kernel 失败分类器:结构化字段优先、原文规则其次,认不出记 unknown 并留原文)。
   * 宿主卡死判定给出的失败(错误对象带 stall: no_response/stalled/stream_dropped)按「整轮已判失败」处理,不再静默重试同一轮(D26 §8.3)。
   */
  private classify(err: unknown): FailureClass {
    let text = "";
    let httpStatus: number | null = null;
    let kind: string | null = null;
    let stall: "no_response" | "stalled" | "stream_dropped" | null = null;
    try {
      text = err instanceof Error ? err.message || err.name : typeof err === "string" ? err : (JSON.stringify(err) ?? String(err));
      const e = (typeof err === "object" && err !== null ? err : {}) as { status?: unknown; httpStatus?: unknown; statusCode?: unknown; kind?: unknown; stall?: unknown };
      const st = e.status ?? e.httpStatus ?? e.statusCode;
      if (typeof st === "number" && Number.isInteger(st)) httpStatus = st;
      if (typeof e.kind === "string") kind = e.kind;
      if (e.stall === "no_response" || e.stall === "stalled" || e.stall === "stream_dropped") stall = e.stall;
    } catch {
      text ||= "(读不出错误内容)";
    }
    return classifyFailure({ text, httpStatus, kind, stall });
  }
  private failureActions(kind: "contact" | "task", currentModel: string): CardActionRow[] {
    const base: CardActionRow[] =
      kind === "contact"
        ? [{ actionId: "retry", label: "重试本轮", style: "primary" }, { actionId: "skip", label: "跳过本轮", style: "default" }]
        : [{ actionId: "retry", label: "重试(同一会话续跑)", style: "primary" }, { actionId: "give-up", label: "不重试了", style: "danger" }];
    // 换模型重试:列出可选的备用模型,用户选了才换(严禁静默换模)
    const models = this.settings().models.filter((m) => m.id !== currentModel).slice(0, 4);
    return [...base, ...models.map((m): CardActionRow => ({ actionId: `switch-model:${m.id}`, label: `换成 ${m.label || m.id} 重试`.slice(0, 40), style: "default" }))];
  }
  private failureBody(cause: string, cls: Pick<FailureClass, "fix" | "raw">, attempts: number, extra = ""): string {
    const why =
      cause === "exhausted" ? `已自动重试 ${attempts} 次仍然失败。`
        : cause === "permanent" ? "这类错误自动重试也不会好,没有自动重试。"
          : cause === "stall" ? "这一轮卡住没有进展,已判失败,没有再静默重试。"
            : cause === "delivery-unknown" ? "不确定这一轮已经做了哪些外部动作,为免重复,没有自动重发。"
              : cause === "crash-loop" ? "宿主处理这批消息时连续退出,为免无限重启,先停在这里。"
                : "没能继续。";
    const fix = cls.fix && cls.fix !== "—" ? `\n修法:${cls.fix}` : "";
    return `${why}${fix}${extra ? `\n${extra}` : ""}\n\n原文:\n${cls.raw.slice(0, 8000) || "(没有原文)"}`.slice(0, 20000);
  }
  /** 宿主机械出一张原位失败卡(发送者记为出问题的联系人,不经它的脑子)。必须在事务里调用。 */
  private postFailureCardTx(roomId: string, senderContactId: string, taskId: string | null, title: string, body: string, actions: CardActionRow[], meta: FailureCardMeta): { roomId: string; seq: number; cardId: string } {
    const cardId = this.newId("card");
    const r = this.appendMessageTx(roomId, { kind: "contact", id: senderContactId }, {
      text: title.slice(0, 200),
      actionKey: `failure:${cardId}`,
      card: { card_id: cardId, kind: "failure", task_id: taskId, title: title.slice(0, 200), body, state: "open", actions: JSON.stringify(actions.slice(0, 6)), meta: JSON.stringify(meta) },
    });
    return { roomId, seq: r.seq, cardId };
  }
  private memberName(m: string): string {
    const [kind, id] = splitMember(m);
    if (kind === "contact") return getDoc<ContactDoc>(this.db, `contact:${id}`)?.value.name ?? id;
    return `任务「${getDoc<TaskDoc>(this.db, `task:${id}`)?.value.title ?? id}」`;
  }
  /** 全群合并的 1 张群级卡(F10/F2)。必须在事务里调用。 */
  private groupCardTx(upstream: string, state: BreakerState, roomId: string, senderContactId: string, cls: Pick<FailureClass, "label" | "fix" | "raw">): { roomId: string; seq: number; cardId: string } {
    const names = state.members.map((m) => this.memberName(m)).join("、");
    const title = `${cls.label}:共用这个上游的${state.members.length > 1 ? ` ${state.members.length} 位成员` : "成员"}先暂停`;
    const how = state.manualOnly ? "鉴权或额度有问题,不会自动重试;修好以后点「重试」。" : "连续失败,后台重试已暂停;过一会儿会自动探测一次,恢复后接着处理,也可以现在点「重试」。";
    const body = this.failureBody("", { fix: cls.fix, raw: cls.raw }, 0, `${names} 用的上游 ${upstream} ${how}`).replace(/^没能继续。\n?/, "");
    const actions: CardActionRow[] = [{ actionId: "retry", label: "重试", style: "primary" }, { actionId: "skip", label: "跳过失败的这批消息", style: "default" }];
    return this.postFailureCardTx(roomId, senderContactId, null, title, body, actions, { scope: "breaker", subject: upstream, contactId: senderContactId, upstream, attemptSeq: 0, models: [] });
  }
  /** 在途轮次标记(F12):本轮开始写、提交时删;宿主中途退出就留在库里,重启时据此认出未提交轮次。 */
  private markRunning(contactId: string, batchKey: string, roomId: string | null, lastSeen: Record<string, number>, inboxEnd: number) {
    run(
      this.db,
      `INSERT INTO gg_round_guard (contact_id, running, boot_id, batch_key, room_id, batch_end, inbox_end, crash_key, crash_count, started_at) VALUES (?, 1, ?, ?, ?, ?, ?, NULL, 0, ?)
       ON CONFLICT (contact_id) DO UPDATE SET running = 1, boot_id = excluded.boot_id, batch_key = excluded.batch_key, room_id = excluded.room_id,
         batch_end = excluded.batch_end, inbox_end = excluded.inbox_end, started_at = excluded.started_at`,
      contactId, this.bootId, batchKey, roomId, JSON.stringify(lastSeen), inboxEnd, this.now(),
    );
  }
  private clearRunningTx(contactId: string) {
    run(this.db, "UPDATE gg_round_guard SET running = 0 WHERE contact_id = ?", contactId);
  }

  /** 联系人一轮失败:按 A×B 决定静默退避(抛 RoundRetry 交注意循环按延迟重跑)、出原位失败卡,或被共享熔断暂停;后两种返回 done 停在原位。 */
  private onContactFailure(contactId: string, name: string, err: unknown, ctx: { upstream: string; focusRoom: string | null; lastSeen: Record<string, number>; inboxEnd: number }): RoundStatus {
    const cls = this.classify(err);
    const heal = healOf(cls.reasonClass);
    if (heal === "user_stopped") {
      // 用户主动中断不是失败(F7):清掉残留的瞬态错误,0 重试 0 出卡
      tx(this.db, () => {
        run(this.db, "DELETE FROM gg_failures WHERE scope = 'contact' AND subject = ?", contactId);
        this.clearRunningTx(contactId);
      });
      this.emitRetry({ scope: "contact", contactId, taskId: null, roomId: ctx.focusRoom, state: "cleared", attempt: 0, limit: 0, label: cls.label });
      return "done";
    }
    const prev = this.failureRow("contact", contactId);
    const continuing = prev?.status === "retrying" || prev?.status === "paused";
    const attempts = prev?.status === "retrying" ? prev.attempts : 0;
    // 失败批次末尾 failed_batch_end_seq:同一次失败的后续重试沿用第一次失败时的位置,失败期间新到的消息不算进去
    const batchEnd = continuing && prev.batch_end !== "{}" ? prev.batch_end : JSON.stringify(ctx.lastSeen);
    const inboxEnd = continuing && prev.inbox_end ? prev.inbox_end : ctx.inboxEnd;
    const room = ctx.focusRoom ?? prev?.room_id ?? this.roomsOfContact(contactId)[0]?.id ?? null;
    const model = prev?.model_override ?? null;
    const b = this.breakerRow(ctx.upstream);
    const br = breakerFailure(b.state, { nowMs: this.clock(), heal, member: `contact:${contactId}`, reason: cls.label }, this.breakerPolicy);
    const row = (status: FailureRow["status"], over: Partial<FailureRow> = {}): Omit<FailureRow, "created_at" | "updated_at"> => ({
      scope: "contact", subject: contactId, contact_id: contactId, status, heal, effect: "B0", reason_class: cls.reasonClass, label: cls.label, fix: cls.fix, raw: cls.raw,
      attempts, attempt_seq: prev?.attempt_seq ?? 0, batch_end: batchEnd, inbox_end: inboxEnd, room_id: room, upstream: ctx.upstream, card_id: null, model_override: model, compute_id: null, delivery_unknown: 0, ...over,
    });
    if (br.ok && br.state.status !== "closed") {
      // 共享熔断打开:暂停,不出自己的卡;当前没有可点的群级卡(刚打开,或用户发起的探测又失败了)才出 1 张
      let card = null as { roomId: string; seq: number; cardId: string } | null;
      tx(this.db, () => {
        this.upsertFailureTx(row("paused"));
        this.clearRunningTx(contactId);
        if (room && (br.opened || !b.card_id)) {
          card = this.groupCardTx(ctx.upstream, br.state, room, contactId, cls);
          this.saveBreaker(ctx.upstream, br.state, { card_id: card.cardId, room_id: room });
        } else this.saveBreaker(ctx.upstream, br.state);
      });
      if (card) this.afterAppend(card.roomId, card.seq, { kind: "contact", id: contactId });
      this.armBreakerProbe(ctx.upstream);
      this.emitRetry({ scope: "contact", contactId, taskId: null, roomId: room, state: "paused", attempt: 0, limit: 0, label: cls.label });
      return "done";
    }
    const d = decideRetry({ heal, effect: "B0", attempts, harnessAttempts: 0, stallJudged: cls.via === "stall" }, this.retryPolicy, this.random);
    if (d.kind === "retry") {
      tx(this.db, () => {
        this.upsertFailureTx(row("retrying", { attempts: d.attempt }));
        if (br.ok) this.saveBreaker(ctx.upstream, br.state);
        this.clearRunningTx(contactId);
      });
      this.emitRetry({ scope: "contact", contactId, taskId: null, roomId: room, state: "retrying", attempt: d.attempt, limit: d.limit, label: cls.label });
      throw new RoundRetry(d.delayMs, cls.label);
    }
    const cause = d.kind === "card" ? d.cause : "permanent";
    let card = null as { roomId: string; seq: number; cardId: string } | null;
    tx(this.db, () => {
      const attemptSeq = (prev?.attempt_seq ?? 0) + 1;
      if (room) {
        const contact = getDoc<ContactDoc>(this.db, `contact:${contactId}`)?.value;
        const current = model ?? contact?.speakingModel ?? "";
        const actions = this.failureActions("contact", current);
        card = this.postFailureCardTx(room, contactId, null, `${name} 这一轮没回成:${cls.label}`, this.failureBody(cause, cls, attempts), actions, {
          scope: "contact", subject: contactId, contactId, upstream: ctx.upstream, attemptSeq, models: switchModels(actions),
        });
      }
      this.upsertFailureTx(row("card", { attempt_seq: attemptSeq, card_id: card?.cardId ?? null }));
      if (br.ok) this.saveBreaker(ctx.upstream, br.state);
      this.clearRunningTx(contactId);
    });
    if (card) this.afterAppend(card.roomId, card.seq, { kind: "contact", id: contactId });
    this.emitRetry({ scope: "contact", contactId, taskId: null, roomId: room, state: "card", attempt: attempts, limit: 0, label: cls.label });
    return "done";
  }

  /** 当前实例执行失败(在事务里):按 A×B 决定同一会话续跑、出卡或被熔断暂停;返回 null 表示照旧走 ExecFailed(越界违规、不在执行中等)。 */
  private onComputeFailureTx(row: { task_id: string; contact_id: string; room_id: string }, ev: Extract<ComputeEvent, { kind: "failed" }>): ComputeFailureOutcome | null {
    if (ev.violations.length) return null;
    const doc = this.taskDoc(row.task_id).value;
    const t = doc.task;
    if (t.computeId !== ev.computeId || (t.state !== "T3_Running" && t.state !== "T4b_BlockedOnHuman")) return null;
    const cls = classifyFailure({ text: ev.reason, httpStatus: null, kind: null });
    const heal = healOf(cls.reasonClass);
    if (heal === "user_stopped") return null;
    const prev = this.failureRow("task", row.task_id);
    const attempts = prev?.status === "retrying" ? prev.attempts : 0;
    // 维度 B:已经有过真实进展的,工作区可能已有改动,按可对账的 B1 处理;分类器判不知道副作用做没做完的一律 B2
    const progressed = !!one(this.db, "SELECT 1 FROM gg_progress WHERE compute_id = ? AND kind IN ('milestone', 'blocked') LIMIT 1", ev.computeId);
    const effect = effectOf(progressed ? "B1" : "B0", cls.retryClass);
    const model = prev?.model_override ?? one<{ model: string }>(this.db, "SELECT model FROM gg_compute WHERE compute_id = ?", ev.computeId)?.model ?? "";
    const upstream = this.upstreamKey(model);
    // 统一重试权(F3):CLI 自己按 CLAUDE_CODE_MAX_RETRIES 重试过上游错误,计入同一预算,宿主不再叠加。
    // 适配器的失败原因常常只有「进程以 N 退出」、看不出是不是上游错误(实测:上游一直 502 时也是这样),所以只要不是被信号结束,都按 CLI 已用掉预算算
    const harnessAttempts = ev.signal === null ? Math.max(0, this.opts.computeHarnessRetries ?? 0) : 0;
    const b = this.breakerRow(upstream);
    const br = breakerFailure(b.state, { nowMs: this.clock(), heal, member: `task:${row.task_id}`, reason: cls.label }, this.breakerPolicy);
    const base = (status: FailureRow["status"], over: Partial<FailureRow> = {}): Omit<FailureRow, "created_at" | "updated_at"> => ({
      scope: "task", subject: row.task_id, contact_id: row.contact_id, status, heal, effect, reason_class: cls.reasonClass, label: cls.label, fix: cls.fix, raw: cls.raw,
      attempts, attempt_seq: prev?.attempt_seq ?? 0, batch_end: "{}", inbox_end: 0, room_id: doc.roomId, upstream, card_id: null, model_override: prev?.model_override ?? null,
      compute_id: ev.computeId, delivery_unknown: effect === "B2" ? 1 : 0, ...over,
    });
    if (br.ok && br.state.status !== "closed") {
      this.upsertFailureTx(base("paused"));
      let card = null as { roomId: string; seq: number; cardId: string } | null;
      if (br.opened || !b.card_id) {
        card = this.groupCardTx(upstream, br.state, doc.roomId, row.contact_id, cls);
        this.saveBreaker(upstream, br.state, { card_id: card.cardId, room_id: doc.roomId });
      } else this.saveBreaker(upstream, br.state);
      return { kind: "paused", upstream, card, label: cls.label };
    }
    if (br.ok) this.saveBreaker(upstream, br.state);
    const d = decideRetry({ heal, effect, attempts, harnessAttempts }, this.retryPolicy, this.random);
    if (d.kind === "retry") {
      this.upsertFailureTx(base("retrying", { attempts: d.attempt }));
      return { kind: "retry", delayMs: d.delayMs, attempt: d.attempt, limit: d.limit, label: cls.label };
    }
    const cause = d.kind === "card" ? d.cause : "permanent";
    const attemptSeq = (prev?.attempt_seq ?? 0) + 1;
    const actions = this.failureActions("task", model);
    const card = this.postFailureCardTx(doc.roomId, row.contact_id, row.task_id, `任务「${doc.title}」执行中断:${cls.label}`, this.failureBody(cause, cls, attempts + harnessAttempts), actions, {
      scope: "task", subject: row.task_id, contactId: row.contact_id, upstream, attemptSeq, models: switchModels(actions),
    });
    this.upsertFailureTx(base("card", { attempt_seq: attemptSeq, card_id: card.cardId }));
    return { kind: "card", card, label: cls.label };
  }
  private afterComputeFailure(row: { task_id: string; contact_id: string; room_id: string }, o: ComputeFailureOutcome) {
    const roomId = this.taskDoc(row.task_id).value.roomId;
    if (o.kind === "retry") {
      this.emitRetry({ scope: "task", contactId: row.contact_id, taskId: row.task_id, roomId, state: "retrying", attempt: o.attempt, limit: o.limit, label: o.label });
      this.scheduleComputeResume(row.task_id, o.delayMs);
      return;
    }
    if (o.card) this.afterAppend(o.card.roomId, o.card.seq, { kind: "contact", id: row.contact_id });
    this.emitRetry({ scope: "task", contactId: row.contact_id, taskId: row.task_id, roomId, state: o.kind === "paused" ? "paused" : "card", attempt: 0, limit: 0, label: o.label });
    if (o.kind === "paused") this.armBreakerProbe(o.upstream);
  }
  private scheduleComputeResume(taskId: string, ms: number, note?: string) {
    this.setHostTimer(`task:${taskId}`, ms, () => void this.retryCompute(taskId, note));
  }
  /**
   * 续跑同一实例(Tier 1:同一 CLI 会话 --resume,不从头 spawn,已落盘的步骤不重跑);续不上就出卡交用户。
   * 走和其它续接同一条路:先拿 Compute 槽位(AC-23,没空位就排队),这一轮的生效模型由 computeTurn 现场解析并记进尝试账本(AC-51/AC-32)。
   */
  private async retryCompute(taskId: string, note?: string) {
    if (this.closed) return;
    const f = this.failureRow("task", taskId);
    if (f?.status !== "retrying" || !f.compute_id) return;
    const doc = getDoc<TaskDoc>(this.db, `task:${taskId}`)?.value;
    if (!doc || doc.task.computeId !== f.compute_id || (doc.task.state !== "T3_Running" && doc.task.state !== "T4b_BlockedOnHuman")) {
      run(this.db, "DELETE FROM gg_failures WHERE scope = 'task' AND subject = ?", taskId);
      return;
    }
    if (!this.admitUpstream(f.upstream, "background")) return this.pauseBehindBreaker("task", taskId, f.contact_id, f.upstream, doc.roomId, null, 0);
    const e = { kind: "resume" as const, taskId, computeId: f.compute_id, text: this.resumePrompt(taskId, f, note) };
    if (!this.takeSlot(e, f.contact_id, doc.roomId)) return;
    let r: { ok: true } | { ok: false; reason: string };
    try {
      r = (await this.computeTurn(e, f.model_override ? "switch-retry" : "retry")) ? { ok: true } : { ok: false, reason: "这一轮没能送进 Compute(见进度)" };
    } catch (err) {
      r = { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
    if (r.ok) {
      this.launchEpoch.set(taskId, (this.launchEpoch.get(taskId) ?? 0) + 1);
      return;
    }
    this.giveBack(taskId);
    if (r.ok || this.closed) return;
    // 续不上(例如上一轮没拿到 CLI 会话号):不另起一个从头跑的 Compute,出卡交用户
    let card = null as { roomId: string; seq: number; cardId: string } | null;
    tx(this.db, () => {
      const cur = this.failureRow("task", taskId);
      if (cur?.status !== "retrying") return;
      const attemptSeq = cur.attempt_seq + 1;
      const model = cur.model_override ?? one<{ model: string }>(this.db, "SELECT model FROM gg_compute WHERE compute_id = ?", f.compute_id)?.model ?? "";
      const actions = this.failureActions("task", model);
      card = this.postFailureCardTx(doc.roomId, cur.contact_id, taskId, `任务「${doc.title}」续跑不了:${cur.label}`, this.failureBody("", { fix: cur.fix, raw: cur.raw }, cur.attempts, `续跑被拒:${r.reason}`).replace(/^没能继续。\n?/, ""), actions, {
        scope: "task", subject: taskId, contactId: cur.contact_id, upstream: cur.upstream, attemptSeq, models: switchModels(actions),
      });
      run(this.db, "UPDATE gg_failures SET status = 'card', attempt_seq = ?, card_id = ?, updated_at = ? WHERE scope = 'task' AND subject = ?", attemptSeq, card.cardId, this.now(), taskId);
    });
    if (card) {
      this.afterAppend(card.roomId, card.seq, { kind: "contact", id: f.contact_id });
      this.emitRetry({ scope: "task", contactId: f.contact_id, taskId, roomId: doc.roomId, state: "card", attempt: f.attempts, limit: 0, label: f.label });
    }
  }
  private resumePrompt(taskId: string, f: FailureRow, note?: string): string {
    const head = note ? `${note}(上一轮中断原因:${f.label})。` : `上一轮执行中断(${f.label}),这是第 ${f.attempts} 次自动续跑。`;
    return [
      head,
      "这是同一个会话,对话历史还在:已经确认做完的步骤不要重做,从中断的地方接着做。",
      "动手改文件之前先看一眼工作区现状,已经写进去的改动不要再追加一遍;已经发出去的消息或外部动作不要再发一遍。",
      this.workspaceNote(taskId),
    ]
      .filter(Boolean)
      .join("\n");
  }
  /** 窗口 ② 对账(A27-03 底座):把工作区 git status 摘要带进续跑提示,防止把已写入的补丁重复追加第二遍;不是 git 仓库或读不到就不带。 */
  private workspaceNote(taskId: string): string {
    let cwd: string | undefined;
    try {
      cwd = this.opts.computeCwd?.(taskId);
    } catch {
      return "";
    }
    if (!cwd || !existsSync(cwd)) return "";
    // 剥掉 GIT_* 环境:宿主在 git 钩子或别的仓库环境里运行时,不能读到宿主自己的仓库
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));
    const r = spawnSync("git", ["-C", cwd, "status", "--porcelain=v1", "--untracked-files=all"], { encoding: "utf8", timeout: 5000, env });
    if (r.status !== 0 || typeof r.stdout !== "string") return "";
    const lines = r.stdout.split("\n").filter(Boolean);
    if (!lines.length) return "工作区现状:没有未提交的改动。";
    return `工作区现状(git status,共 ${lines.length} 项):\n${lines.slice(0, 50).join("\n")}${lines.length > 50 ? "\n…" : ""}`;
  }
  /** 任务被取消(F7):在途失败(残留瞬态错误、待续跑)一并清掉,不再续跑、不出失败卡;失败退出的实例已经没有进程,当场确认停止。必须在事务里调用。 */
  private afterCancelTx(taskId: string) {
    const f = this.failureRow("task", taskId);
    if (!f) return;
    run(this.db, "DELETE FROM gg_failures WHERE scope = 'task' AND subject = ?", taskId);
    if (f.card_id) run(this.db, "UPDATE gg_cards SET state = 'expired' WHERE card_id = ? AND state = 'open'", f.card_id);
    const t = this.taskDoc(taskId).value.task;
    const dead = f.compute_id ? one<{ status: string }>(this.db, "SELECT status FROM gg_compute WHERE compute_id = ?", f.compute_id)?.status === "failed" : false;
    if (t.state === "T9_StopRequested" && f.compute_id && t.computeId === f.compute_id && dead) this.stepTaskTx(taskId, { kind: "StoppedConfirmed", taskId, computeId: f.compute_id });
  }
  /** 失败卡点击的领取判定(与 kernel claimFailureCard 同一规则);卡已过期(失败已恢复或已有新的一张)直接拒。 */
  private checkFailureClaim(card: CardRow, actionId: string): FailureDecision {
    const meta = JSON.parse(card.meta) as FailureCardMeta;
    const switching = actionId.startsWith("switch-model:");
    const action = (switching ? "switch-model" : actionId) as FailureDecision["action"];
    const targetModel = switching ? actionId.slice("switch-model:".length) : null;
    let current = false;
    let attemptSeq = meta.attemptSeq;
    let row: FailureRow | undefined;
    if (meta.scope === "breaker") {
      const b = this.breakerRow(meta.upstream);
      current = b.card_id === card.card_id && b.state.status !== "closed";
    } else {
      row = this.failureRow(meta.scope, meta.subject);
      current = !!row && row.card_id === card.card_id && row.status === "card";
      attemptSeq = row?.attempt_seq ?? attemptSeq;
    }
    // 已被点过(连点、与自动恢复竞争)按 CAS 规则拒;还开着但失败已恢复或已有新的一张,就作废这张
    if (card.state !== "open") throw new HostError("conflict", "这张卡已经处理过了");
    if (!current) {
      if (run(this.db, "UPDATE gg_cards SET state = 'expired' WHERE card_id = ? AND state = 'open'", card.card_id)) this.emitCardUpdated(card.card_id);
      throw new HostError("conflict", "这张卡已过期(失败已恢复,或已经有了新的一张)");
    }
    const r = claimFailureCard(
      { status: card.state, ownerUserId: this.userId, contactId: meta.contactId, attemptSeq, allowedModels: meta.models },
      { by: { kind: "user", id: this.userId }, attemptSeq: meta.attemptSeq, action, targetModel },
    );
    if (!r.ok) {
      if (r.reason === "not-open") throw new HostError("conflict", "这张卡已经处理过了");
      if (r.reason === "stale-attempt") throw new HostError("conflict", "这张卡已过期(有了新的一次尝试)");
      if (r.reason === "forbidden") throw new HostError("forbidden", r.detail);
      throw new HostError("invalid_params", r.detail);
    }
    return { card, meta, action, targetModel: r.targetModel, row };
  }
  /** 执行失败卡上的选择(在 cards.act 的事务里);返回事务提交后要做的事。 */
  private applyFailureDecisionTx(d: FailureDecision): () => void {
    const at = this.now();
    const { meta } = d;
    if (meta.scope === "contact") {
      const contactId = meta.subject;
      const f = d.row!;
      if (d.action === "skip") {
        // [跳过本轮] 只推到失败批次末尾 failed_batch_end_seq;失败期间新到的消息(seq 更大)留给下一轮(A27-05)
        const rooms = this.roomsOfContact(contactId);
        const target = skipTarget(Object.fromEntries(rooms.map((r) => [r.id, this.cursor(contactId, r.id)])), JSON.parse(f.batch_end));
        if (target.ok) this.advanceCursorsTx(contactId, { ...target.cursors });
        run(this.db, "UPDATE gg_inbox SET consumed = 1 WHERE contact_id = ? AND consumed = 0 AND id <= ?", contactId, f.inbox_end);
        run(this.db, "DELETE FROM gg_failures WHERE scope = 'contact' AND subject = ?", contactId);
        run(this.db, "DELETE FROM gg_round_guard WHERE contact_id = ?", contactId);
        return () => {
          this.emitRetry({ scope: "contact", contactId, taskId: null, roomId: f.room_id, state: "cleared", attempt: 0, limit: 0, label: "已跳过" });
          this.loop.notify(contactId, "now");
        };
      }
      // [重试本轮] / [换模型重试]:同一批输入连同失败期间新到的消息重新跑,自动退避预算重新算;只有显式选了才换模型
      run(
        this.db,
        "UPDATE gg_failures SET status = 'retrying', attempts = 0, card_id = NULL, batch_end = '{}', inbox_end = 0, model_override = COALESCE(?, model_override), updated_at = ? WHERE scope = 'contact' AND subject = ?",
        d.targetModel, at, contactId,
      );
      return () => this.loop.notify(contactId, "now");
    }
    if (meta.scope === "task") {
      const taskId = meta.subject;
      const f = d.row!;
      if (d.action === "give-up") {
        run(this.db, "DELETE FROM gg_failures WHERE scope = 'task' AND subject = ?", taskId);
        const t = this.taskDoc(taskId).value.task;
        if (f.compute_id && t.computeId === f.compute_id && !TERMINAL.has(t.state) && t.state !== "T9_StopRequested") {
          this.stepTaskTx(taskId, { kind: "ExecFailed", computeId: f.compute_id });
          // 失败退出的实例已经没有进程:当场确认停止,任务落到 T11
          if (this.taskDoc(taskId).value.task.state === "T9_StopRequested") this.stepTaskTx(taskId, { kind: "StoppedConfirmed", taskId, computeId: f.compute_id });
        }
        const doc = this.taskDoc(taskId).value;
        const payload: Inbound = { kind: "compute", roomId: doc.roomId, taskId, computeId: f.compute_id ?? "-", signal: "failed", summary: `失败:${f.label}(用户选了不重试)`, at };
        run(this.db, "INSERT INTO gg_inbox (contact_id, room_id, payload, at) VALUES (?, ?, ?, ?)", f.contact_id, doc.roomId, JSON.stringify(payload), at);
        return () => {
          this.emitTask(taskId);
          this.emitRetry({ scope: "task", contactId: f.contact_id, taskId, roomId: doc.roomId, state: "cleared", attempt: 0, limit: 0, label: "不重试了" });
          this.loop.notify(f.contact_id, "now");
        };
      }
      // 半途换模(F13):新模型并入累积生产集合,T5 审查门据此同时拒绝两家厂商;启动快照不在本片(AC-32)
      if (d.action === "switch-model" && d.targetModel && f.compute_id) this.stepTaskTx(taskId, { kind: "ProducerModelAdded", model: d.targetModel, computeId: f.compute_id });
      run(this.db, "UPDATE gg_failures SET status = 'retrying', attempts = 0, card_id = NULL, model_override = COALESCE(?, model_override), updated_at = ? WHERE scope = 'task' AND subject = ?", d.targetModel, at, taskId);
      const note = d.action === "switch-model" ? `用户选了换成 ${d.targetModel} 重试这一轮` : "用户点了重试";
      const breakerOpen = this.breakerRow(f.upstream).state.status !== "closed";
      return () => {
        this.emitTask(taskId);
        if (breakerOpen) this.manualProbe.add(f.upstream);
        this.scheduleComputeResume(taskId, 0, note);
      };
    }
    // 群级卡
    const upstream = meta.upstream;
    const b = this.breakerRow(upstream);
    const contacts: string[] = [];
    const tasks: string[] = [];
    for (const m of b.state.members) {
      const [kind, id] = splitMember(m);
      if (kind === "contact") contacts.push(id);
      if (kind === "task") tasks.push(id);
    }
    if (d.action === "retry") {
      // 用户在群级卡上点[重试]:不等冷却,放 1 个半开探测;其余成员等探测结果。这张卡用掉了,探测再失败会出新的一张
      for (const id of contacts) run(this.db, "UPDATE gg_failures SET status = 'retrying', attempts = 0, updated_at = ? WHERE scope = 'contact' AND subject = ? AND status = 'paused'", at, id);
      for (const id of tasks) run(this.db, "UPDATE gg_failures SET status = 'retrying', attempts = 0, updated_at = ? WHERE scope = 'task' AND subject = ? AND status = 'paused'", at, id);
      this.saveBreaker(upstream, b.state, { card_id: null, room_id: null });
      return () => {
        this.manualProbe.add(upstream);
        for (const id of contacts) this.loop.notify(id, "now");
        for (const id of tasks) this.scheduleComputeResume(id, 0, "用户点了重试");
      };
    }
    // [跳过]:联系人成员各自只跳过自己失败的那一批;任务成员各出自己的卡由用户逐个定;熔断清零
    const cards: { roomId: string; seq: number; sender: string }[] = [];
    for (const id of contacts) {
      const f = this.failureRow("contact", id);
      if (!f) continue;
      const rooms = this.roomsOfContact(id);
      const target = skipTarget(Object.fromEntries(rooms.map((r) => [r.id, this.cursor(id, r.id)])), JSON.parse(f.batch_end));
      if (target.ok) this.advanceCursorsTx(id, { ...target.cursors });
      run(this.db, "UPDATE gg_inbox SET consumed = 1 WHERE contact_id = ? AND consumed = 0 AND id <= ?", id, f.inbox_end);
      run(this.db, "DELETE FROM gg_failures WHERE scope = 'contact' AND subject = ?", id);
      run(this.db, "DELETE FROM gg_round_guard WHERE contact_id = ?", id);
    }
    for (const id of tasks) {
      const f = this.failureRow("task", id);
      const doc = getDoc<TaskDoc>(this.db, `task:${id}`)?.value;
      if (!f || !doc) continue;
      const attemptSeq = f.attempt_seq + 1;
      const model = f.model_override ?? one<{ model: string }>(this.db, "SELECT model FROM gg_compute WHERE compute_id = ?", f.compute_id ?? "")?.model ?? "";
      const actions = this.failureActions("task", model);
      const c = this.postFailureCardTx(doc.roomId, f.contact_id, id, `任务「${doc.title}」执行中断:${f.label}`, this.failureBody(f.heal === "A2" || f.heal === "A3" ? "permanent" : "exhausted", { fix: f.fix, raw: f.raw }, f.attempts), actions, {
        scope: "task", subject: id, contactId: f.contact_id, upstream, attemptSeq, models: switchModels(actions),
      });
      run(this.db, "UPDATE gg_failures SET status = 'card', attempt_seq = ?, card_id = ?, updated_at = ? WHERE scope = 'task' AND subject = ?", attemptSeq, c.cardId, at, id);
      cards.push({ roomId: c.roomId, seq: c.seq, sender: f.contact_id });
    }
    this.saveBreaker(upstream, BREAKER_CLOSED, { card_id: null, room_id: null });
    return () => {
      this.clearHostTimer(`breaker:${upstream}`);
      for (const c of cards) this.afterAppend(c.roomId, c.seq, { kind: "contact", id: c.sender });
      for (const id of contacts) {
        this.emitRetry({ scope: "contact", contactId: id, taskId: null, roomId: null, state: "cleared", attempt: 0, limit: 0, label: "已跳过" });
        this.loop.notify(id, "now");
      }
    };
  }
  /** 启动回收(F4/F6/F12):上次留下的在途轮次按 crash_recovery_count 续跑或熔断出卡;磁盘上没被领走的输入交给联系人;等续跑的任务、被暂停的成员接着排。 */
  private reconcileOnStart() {
    const cards: { roomId: string; seq: number; contactId: string }[] = [];
    const max = this.opts.maxCrashRecoveries ?? 1;
    tx(this.db, () => {
      // 新进程里不会有在途的半开探测
      for (const b of all<{ upstream: string; state: string }>(this.db, "SELECT upstream, state FROM gg_breakers")) {
        const st = JSON.parse(b.state) as BreakerState;
        if (st.probeInFlight) this.saveBreaker(b.upstream, { ...st, probeInFlight: false });
      }
      for (const g of all<GuardRow>(this.db, "SELECT * FROM gg_round_guard WHERE running = 1")) {
        const r = crashRecover({ key: g.crash_key, count: g.crash_count }, { key: g.batch_key, effect: "B0" }, max);
        if (!r.ok) continue;
        run(this.db, "UPDATE gg_round_guard SET running = 0, crash_key = ?, crash_count = ? WHERE contact_id = ?", r.state.key, r.state.count, g.contact_id);
        if (r.decision !== "blocked") continue;
        // 同一输入第 2 次让宿主退出:CrashLoopBlocked,出卡停在原位,不再自启续跑
        const contact = getDoc<ContactDoc & { removed?: boolean }>(this.db, `contact:${g.contact_id}`)?.value;
        const room = g.room_id ?? this.roomsOfContact(g.contact_id)[0]?.id ?? null;
        if (!contact || contact.removed || !room) continue;
        const prev = this.failureRow("contact", g.contact_id);
        const attemptSeq = (prev?.attempt_seq ?? 0) + 1;
        const cls = { label: "处理这批消息时宿主连续退出", fix: "先跳过这一批,或换个模型重试", raw: `crash_recovery_count=${r.state.count}(同一批输入已让宿主退出 ${r.state.count} 次)` };
        const actions = this.failureActions("contact", prev?.model_override ?? contact.speakingModel);
        const upstream = this.upstreamKey(prev?.model_override ?? contact.speakingModel);
        const c = this.postFailureCardTx(room, g.contact_id, null, `${contact.name} 这一轮没回成:${cls.label}`, this.failureBody("crash-loop", cls, 0), actions, {
          scope: "contact", subject: g.contact_id, contactId: g.contact_id, upstream, attemptSeq, models: switchModels(actions),
        });
        this.upsertFailureTx({
          scope: "contact", subject: g.contact_id, contact_id: g.contact_id, status: "card", heal: "unknown", effect: "B0", reason_class: "crash_loop", label: cls.label, fix: cls.fix, raw: cls.raw,
          attempts: 0, attempt_seq: attemptSeq, batch_end: g.batch_end, inbox_end: g.inbox_end, room_id: room, upstream, card_id: c.cardId, model_override: prev?.model_override ?? null, compute_id: null, delivery_unknown: 0,
        });
        cards.push({ roomId: c.roomId, seq: c.seq, contactId: g.contact_id });
      }
    });
    for (const c of cards) {
      this.afterAppend(c.roomId, c.seq, { kind: "contact", id: c.contactId });
      this.emitRetry({ scope: "contact", contactId: c.contactId, taskId: null, roomId: c.roomId, state: "card", attempt: 0, limit: 0, label: "处理这批消息时宿主连续退出" });
    }
    // 磁盘上还没被领走的输入(F4 未提交轮次、F6 丢了通知的 Compute 终态):不等人类新发言,直接交给联系人
    for (const c of this.listContacts()) if (this.hasPendingInput(c.id)) this.loop.notify(c.id, "now");
    for (const f of all<{ subject: string }>(this.db, "SELECT subject FROM gg_failures WHERE scope = 'task' AND status = 'retrying'")) this.scheduleComputeResume(f.subject, 0);
    for (const b of all<{ upstream: string }>(this.db, "SELECT upstream FROM gg_breakers")) this.armBreakerProbe(b.upstream);
  }
  private hasPendingInput(contactId: string): boolean {
    if (one(this.db, "SELECT 1 FROM gg_inbox WHERE contact_id = ? AND consumed = 0 LIMIT 1", contactId)) return true;
    return this.roomsOfContact(contactId).some((r) => this.lastSeq(r.id) > this.cursor(contactId, r.id));
  }

  // ======================= 生命周期 =======================
  async idle(): Promise<void> {
    await this.loop.idle();
  }
  async close(): Promise<void> {
    this.closed = true;
    for (const h of this.hostTimers.values()) this.timersApi.clear(h);
    this.hostTimers.clear();
    this.scheduler.stop();
    await this.loop.stop();
    for (const a of this.adapters.values()) {
      for (const r of all<{ compute_id: string }>(this.db, "SELECT compute_id FROM gg_compute WHERE status IN ('starting','running')")) {
        try {
          await a.stop(r.compute_id);
        } catch {
          /* 关闭时尽力停止 */
        }
      }
    }
    this.db.close();
  }
}

/** 第 1 块人设:先写明这位联系人是谁(群里据此分清 @ 的是不是自己),再接用户设的人设原文。只随改名/改人设变,前缀缓存不受每轮影响。 */
function identityOf(contactId: string, c: { name: string; persona: string }): string {
  return [`你是「${c.name}」(联系人 id ${contactId})。消息里的 @ 列的是联系人 id。`, c.persona].filter((x) => x.trim()).join("\n");
}
/** 保存被拒时给人看的说明:列出每位会冲突的联系人和原因。 */
function incompatibleMessage(conflicts: readonly modelConfig.AffectedContact[]): string {
  const names = conflicts.map((a) => `${a.name}(${a.after.harness} 不支持 ${a.after.model})`).join("、");
  return `这次改动会让 ${conflicts.length} 位联系人的 Compute 与所选 Harness 不兼容:${names}。可以单独指定兼容的模型或更换 Harness;看过预览确认后再保存`;
}
/** 这一轮的生效模型(AC-51):宿主每次送进 Compute 的输入都带上。 */
export interface TurnModel {
  readonly model: string;
  readonly effort?: string;
}
type TurnRefusal = { ok: false; reason: string; code?: string; fixes?: readonly string[] };
/** 声明了按轮换模型能力(capabilities)的适配器:spawn 收 model/effort,resume 收这一轮的生效模型。 */
function isModelAware(a: ComputeAdapter): boolean {
  return "capabilities" in a && typeof (a as { capabilities?: unknown }).capabilities === "object";
}
/** 事件里 harness 回报的实际模型:started.model;completed/failed 的 models(这一轮 modelUsage 的键)。旧适配器没有这些字段。 */
function reportedModels(ev: ComputeEvent): string[] {
  const x = ev as ComputeEvent & { model?: unknown; models?: unknown };
  if (ev.kind === "started") return typeof x.model === "string" && x.model ? [x.model] : [];
  if (ev.kind === "completed" || ev.kind === "failed") return Array.isArray(x.models) ? x.models.filter((m): m is string => typeof m === "string" && m !== "") : [];
  return [];
}

function defaultsOf(s: SettingsView): modelConfig.ModelDefaults {
  return { harness: s.defaultHarness, speakingModel: s.defaultSpeakingModel, computeModel: s.defaultComputeModel, effort: s.defaultEffort };
}
function capsOf(s: SettingsView): modelConfig.ModelCapability[] {
  return s.models.map((m) => ({ id: m.id, harnesses: [...m.harnesses] }));
}
function resolvedView(r: modelConfig.ResolvedCompute) {
  return { harness: r.harness, model: r.model, effort: r.effort, vendor: r.vendor, modelSource: r.modelSource, effortSource: r.effortSource, chain: [...r.chain] };
}
function previewView(p: modelConfig.ChangePreview): ModelChangePreview {
  return {
    defaultsChanged: [...p.defaultsChanged],
    affected: p.affected.map((a) => ({
      contactId: a.contactId,
      name: a.name,
      involvement: a.involvement,
      changed: [...a.changed],
      speakingBefore: a.speakingBefore,
      speakingAfter: a.speakingAfter,
      before: resolvedView(a.before),
      after: resolvedView(a.after),
      support: a.support,
      conflict: a.conflict,
      fixes: a.fixes.map((f) => ({ kind: f.kind, candidates: [...f.candidates] })),
    })),
    conflicts: p.conflicts.length,
  };
}

/** 已交付、等提出者回复的任务(AC-56 普通消息交付):T8a,或还没有审查人、停在 T5 等本人豁免。旧数据(交付卡)不算,走卡片。 */
function awaitingUser(d: TaskDoc): boolean {
  if (d.deliveredSeq == null) return false;
  return d.task.state === "T8a_Delivered" || d.task.state === "T5_InReview";
}
export type ModelChangeInput =
  | { kind: "defaults"; defaultHarness?: SettingsView["defaultHarness"]; defaultSpeakingModel?: string; defaultComputeModel?: string; defaultEffort?: SettingsView["defaultEffort"] }
  | { kind: "contact"; contactId: string; speakingModel?: string; harness?: ContactView["harness"]; computeModel?: ContactView["computeModel"] }
  | { kind: "batch-replace"; from: string; to: string };
/** 联系人一轮失败、策略决定静默退避重跑:注意循环按 delayMs 再跑这一轮(AC-36 F1)。 */
class RoundRetry extends Error {
  readonly delayMs: number;
  constructor(delayMs: number, label: string) {
    super(`自动重试:${label}`);
    this.name = "RoundRetry";
    this.delayMs = delayMs;
  }
}
/** gg_failures 一行:一个联系人或任务的在途失败。 */
interface FailureRow {
  scope: "contact" | "task";
  subject: string;
  contact_id: string;
  /** retrying:静默退避中;card:已出原位失败卡、停在原位等用户;paused:被共享熔断暂停 */
  status: "retrying" | "card" | "paused";
  heal: HealClass | string;
  effect: string;
  reason_class: string;
  label: string;
  fix: string;
  raw: string;
  attempts: number;
  attempt_seq: number;
  /** 失败批次末尾 failed_batch_end_seq(各会话),JSON */
  batch_end: string;
  inbox_end: number;
  room_id: string | null;
  upstream: string;
  card_id: string | null;
  model_override: string | null;
  compute_id: string | null;
  delivery_unknown: number;
  created_at: string;
  updated_at: string;
}
interface GuardRow {
  contact_id: string;
  running: number;
  boot_id: string;
  batch_key: string;
  room_id: string | null;
  batch_end: string;
  inbox_end: number;
  crash_key: string | null;
  crash_count: number;
  started_at: string;
}
interface FailureCardMeta {
  scope: "contact" | "task" | "breaker";
  /** 联系人 id、任务 id,或群级卡的上游键 */
  subject: string;
  contactId: string;
  upstream: string;
  attemptSeq: number;
  models: string[];
}
interface FailureDecision {
  card: CardRow;
  meta: FailureCardMeta;
  action: "retry" | "skip" | "give-up" | "switch-model";
  targetModel: string | null;
  row: FailureRow | undefined;
}
type CardActionRow = { actionId: string; label: string; style: "primary" | "default" | "danger" };
type ComputeFailureOutcome =
  | { kind: "retry"; delayMs: number; attempt: number; limit: number; label: string }
  | { kind: "paused"; upstream: string; card: { roomId: string; seq: number } | null; label: string }
  | { kind: "card"; card: { roomId: string; seq: number }; label: string };
const splitMember = (m: string): [string, string] => {
  const i = m.indexOf(":");
  return i < 0 ? [m, ""] : [m.slice(0, i), m.slice(i + 1)];
};
/** 本节出的失败卡(联系人一轮、任务的 Compute、群级熔断卡);别的失败卡(如整轮超预算)不归这里处理。 */
const isRetryCardMeta = (meta: string): boolean => {
  try {
    const m = JSON.parse(meta) as { scope?: unknown };
    return m.scope === "contact" || m.scope === "task" || m.scope === "breaker";
  } catch {
    return false;
  }
};
const switchModels = (actions: readonly CardActionRow[]): string[] => actions.filter((a) => a.actionId.startsWith("switch-model:")).map((a) => a.actionId.slice("switch-model:".length));

type HostEffect =
  | { kind: "spawn"; taskId: string; requestId: string; contactId: string; model: string; brief: string; roomId: string }
  | { kind: "resume"; taskId: string; computeId: string; text: string }
  | { kind: "stop"; taskId: string; computeId: string }
  | { kind: "integrate"; taskId: string; by: string }
  | { kind: "cancel-spawn"; taskId: string; requestId: string };

/** 召回清单的一项 → 第 5 块的一个指针。截断显式写出原长与续读游标;撤回与越权只给状态,不带原文和原长。 */
export function renderRecall(it: RecallItem, sender: string): { ref: string; text: string } {
  const ref = `${it.roomId} #${it.seq}${it.primary ? "(主回复)" : ""}`;
  if (it.state === "Full") return { ref, text: `Full · ${sender} 原文(${it.bytes} 字节):${it.text}` };
  if (it.state === "TruncatedSlice") {
    const c = it.nextCursor!;
    return { ref, text: `TruncatedSlice · ${sender} 原文前 ${it.bytes}/${it.totalBytes} 字节(未完,续读游标 offset=${c.offset},还剩 ${c.remainingBytes} 字节):${it.text}` };
  }
  if (it.state === "DeletedOrWithdrawn") return { ref, text: "DeletedOrWithdrawn · 这条已撤回或已删除,不提供原文" };
  return { ref, text: "AccessDenied · 不在本会话或无权读取,已拒绝" };
}
