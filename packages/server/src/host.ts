// 本地宿主:把领域状态机、SQLite 存储、联系人注意循环、Compute 适配器和承诺账本拼成 P0 最小闭环(AC-30):
//   用户在私聊/群里发消息 → 机械送达每位成员联系人的注意循环 → 联系人一轮(五块重拼 → ContactMind)提出动作
//   → 宿主校验、分配 action_id、与游标/账本/任务同一事务落盘 → 起 Compute → Compute 语义事件回到联系人 → 联系人汇报/交付回聊天。
// 规则:只有联系人对外说话(Compute 不直接发言,AC-03);游标只在一轮落盘后推进(AC-31);发送前检出更新的用户消息就放弃本轮重跑(AC-31 ④);
// 发送入库端按 action_id 去重(AC-31 ③);消息接走即已读(AC-46)。
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { appendEvent, loadLog, recordAction } from "@g-group/adapter-sqlite";
import type { ComputeAdapter, ComputeEvent } from "@g-group/adapter-cc-compute";
import type {
  CommitmentView,
  DraftBody,
  DraftView,
  ComputeProgress,
  ContactView,
  MessageView,
  ReceiptView,
  RewindResult,
  RoomView,
  SettingsView,
  TaskView,
} from "@g-group/api-contract";
import {
  type Ledger,
  type ProjectedMessage,
  type Task,
  type TaskEvent,
  applyLedger,
  apply as applyTask,
  emptyLedger,
  newTask,
  project,
} from "@g-group/domain";
import {
  type AttentionLoop,
  type ContactMind,
  type Inbound,
  type InboundMessage,
  type MindAction,
  type RoundStatus,
  type TimerApi,
  type Urgency,
  createAttentionLoop,
} from "@g-group/kernel";
import { type AnnouncementOrder, AnnouncementStore } from "./announcements.ts";
import { CONTACT_SYSTEM, CONTACT_TOOLS, type LedgerLine, type RoundAssembler, kernelAssemble } from "./assemble.ts";
import { type Bus, createBus } from "./bus.ts";
import { type Db, HostError, all, getDoc, listDocs, one, openDb, putDoc, run, tx } from "./db.ts";
import { EXIT_SETTLED, LEAVING_REASON, MemberExits } from "./members.ts";
import { PluginStore } from "./plugins.ts";
import { type RewindPlan, inRanges, isRewound, planRewind, rewindNotice, rewindRanges } from "./rewind.ts";
import { Scheduler, checkCron } from "./schedules.ts";

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
  /** 派给 Compute 的内置工具白名单;默认 Read/Write/Edit/Glob/Grep/Bash。 */
  readonly computeTools?: readonly string[];
  readonly assemble?: RoundAssembler;
  readonly now?: () => string;
  /** 宿主数据目录(插件包装在这里);默认数据库文件所在目录。 */
  readonly dataDir?: string;
  /** 插件市场目录文件 catalog.json;不给就是空市场。 */
  readonly catalogFile?: string | null;
  /** 定时用的时钟(毫秒);默认 Date.now。 */
  readonly clockMs?: () => number;
  readonly newId?: (prefix: string) => string;
  readonly maxDeferMs?: number;
  readonly timers?: TimerApi;
  readonly onReport?: (what: string, detail: unknown) => void;
  /** 群公告排序(列表与装配共用);默认按创建先后。排序规则待定(D28 待确认 ④),先做成参数。 */
  readonly announcementOrder?: AnnouncementOrder;
}

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
  private readonly opts: HostOptions;
  private readonly now: () => string;
  private readonly newId: (prefix: string) => string;
  private readonly assemble: RoundAssembler;
  private readonly activity = new Map<string, Activity>();
  private readonly adapters = new Map<string, ComputeAdapter>();
  private readonly pumps: Promise<void>[] = [];
  private roundNo = 0;
  private closed = false;

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
    this.bus = createBus(this.now);
    this.loop = createAttentionLoop({
      maxDeferMs: opts.maxDeferMs ?? 1500,
      ...(opts.timers ? { timers: opts.timers } : {}),
      run: (id, signal) => this.runRound(id, signal),
      onReport: (id, what, detail) => this.report(`attention:${what}:${id}`, detail),
    });
    const timers: TimerApi = opts.timers ?? { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) };
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
    // 启动时先处理宿主关着期间到期的定时(按容差与 missedPolicy),再按最早一次设计时器
    this.scheduler.tick();
  }

  private report(what: string, detail: unknown) {
    try {
      this.opts.onReport?.(what, detail);
    } catch {
      /* 报告回调出错不影响宿主 */
    }
  }

  // ======================= 联系人 =======================
  createContact(input: { clientActionId?: string; name: string; bio?: string; speakingModel?: string; harness?: ContactView["harness"]; computeModel?: ContactView["computeModel"]; persona?: string }): ContactView {
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
    putDoc(this.db, `contact:${id}`, 0, doc);
    const view = this.contactView(doc);
    this.bus.emit({ type: "contact.updated", contact: view });
    return view;
  }
  updateContact(id: string, patch: Partial<Omit<ContactDoc, "id" | "createdAt">>): ContactView {
    const cur = this.contactDoc(id);
    const next: ContactDoc = { ...cur.value, ...patch, id, createdAt: cur.value.createdAt };
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
    const { persona: _p, removed: _r, ...rest } = doc as ContactDoc & { removed?: boolean };
    return { ...rest, activity: this.activity.get(doc.id) ?? "idle" };
  }
  listContacts(): ContactView[] {
    return listDocs<ContactDoc & { removed?: boolean }>(this.db, "contact:")
      .filter((d) => !d.value.removed)
      .map((d) => this.contactView(d.value));
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
  updateSettings(patch: Partial<SettingsView>): SettingsView {
    const cur = getDoc<SettingsView>(this.db, "settings");
    const next = { ...(cur?.value ?? DEFAULT_SETTINGS), ...patch };
    putDoc(this.db, "settings", cur?.ver ?? 0, next);
    return next;
  }
  computeModelOf(c: ContactDoc): string {
    const slot = c.computeModel;
    if (slot.mode === "explicit" && slot.model) return slot.model;
    if (slot.mode === "follow-speaking") return c.speakingModel;
    return this.settings().defaultComputeModel;
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
  updateRoom(roomId: string, patch: { title?: string; pinned?: boolean; muted?: boolean; rules?: string; expectedRulesVersion?: number }): RoomView {
    const r = this.roomRow(roomId);
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
      updatedAt: r.updated_at,
      announcementCount: r.kind === "group" ? this.announcements.count(roomId) : 0,
      leavingMembers: this.exits.leavingIn(roomId),
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
    };
  }
  listMessages(roomId: string, q: { beforeSeq?: number; afterSeq?: number; limit?: number; threadRootSeq?: number | null }): { messages: MessageView[]; hasMore: boolean } {
    this.roomRow(roomId);
    const msgs = this.projected(roomId);
    let sel = msgs.filter((m) => (q.beforeSeq === undefined || m.seq < q.beforeSeq) && (q.afterSeq === undefined || m.seq > q.afterSeq));
    if (q.threadRootSeq !== undefined) {
      const roots = new Map(all<{ seq: number; thread_root: number | null }>(this.db, "SELECT seq, thread_root FROM gg_msg WHERE room_id = ?", roomId).map((r) => [r.seq, r.thread_root]));
      sel = sel.filter((m) => (roots.get(m.seq) ?? null) === q.threadRootSeq || (q.threadRootSeq !== null && m.seq === q.threadRootSeq));
    }
    const limit = q.limit ?? 100;
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
    const e = appendEvent(this.db.store, `room:${roomId}`, sender, { kind: "message", text: f.text }, this.now());
    recordAction(this.db.store, key, { seq: e.seq });
    const quoted = [...new Set(f.quotedSeqs ?? [])];
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
    const r = tx(this.db, () =>
      this.appendMessageTx(room.id, me, {
        text: input.text.trim() ? input.text : `[附件 ${input.attachments!.length} 个]`,
        attachments: input.attachments ?? [],
        actionKey: `user:${input.clientActionId}`,
        clientActionId: input.clientActionId,
        threadRootSeq: input.threadRootSeq ?? null,
        replyToSeq: input.replyToSeq ?? null,
        quotedSeqs: input.quotedSeqs ?? [],
        mentions: input.mentions ?? [],
        command: input.command ?? null,
      }),
    );
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
  // ======================= 输入框草稿(红提交空壳) =======================
  draft(roomId: string): DraftView {
    return { roomId, text: "", replyToSeq: null, replyAuthorId: null, quotedSeqs: [], mentions: [], draftVer: 0, updatedAt: null };
  }
  saveDraft(roomId: string, _expectedVer: number, _body: DraftBody): DraftView {
    return this.draft(roomId);
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
      return this.taskView(this.taskDoc(taskId).value);
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
    return this.taskView(this.taskDoc(taskId).value);
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
  taskView(doc: TaskDoc): TaskView {
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
      computeRuns: runs.map((r) => ({
        computeId: r.compute_id,
        harness: r.harness as "claude-code",
        model: r.model,
        placement: "local",
        status: r.status as TaskView["computeRuns"][number]["status"],
        startedAt: r.started_at,
        endedAt: r.ended_at,
      })),
      recentProgress: progress,
      artifacts: doc.result ? [{ ref: `task:${t.id}/result`, name: "结果", kind: "text" }] : [],
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
      ...(doc.description !== undefined ? { description: doc.description } : {}),
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
      .map((d) => d.value)
      .filter((d) => (!q.roomId || d.roomId === q.roomId) && (!q.contactId || d.task.owner === q.contactId) && (!q.states || q.states.includes(d.task.state)))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .map((d) => this.taskView(d));
  }
  private emitTask(id: string) {
    const doc = this.taskDoc(id).value;
    this.bus.emit({ type: "task.updated", task: this.taskView(doc) });
    // 任务每次变化后看负责人是否在这个群移出中:停止确认到了(T10/T11)才真正移出
    if (doc.task.owner) this.settleExit(doc.roomId, doc.task.owner);
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
  private cursor(contactId: string, roomId: string): number {
    return one<{ processed_seq: number }>(this.db, "SELECT processed_seq FROM gg_cursor WHERE contact_id = ? AND room_id = ?", contactId, roomId)?.processed_seq ?? 0;
  }
  private inbox(contactId: string): { id: number; room_id: string; payload: string }[] {
    return all(this.db, "SELECT id, room_id, payload FROM gg_inbox WHERE contact_id = ? AND consumed = 0 ORDER BY id", contactId);
  }
  private toInbound(roomId: string, m: ProjectedMessage): InboundMessage {
    const meta = one<MsgMeta>(this.db, "SELECT * FROM gg_msg WHERE room_id = ? AND seq = ?", roomId, m.seq);
    return {
      kind: "message",
      roomId,
      seq: m.seq,
      sender: { kind: m.sender.kind, id: m.sender.id, name: this.nameOf(m.sender) },
      text: m.text,
      replyToSeq: meta?.reply_to ?? null,
      quotedSeqs: meta ? (JSON.parse(meta.quoted) as number[]) : [],
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
    const pointers: { ref: string; text: string }[] = [];
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
        for (const q of [...ib.quotedSeqs, ...(ib.replyToSeq !== null ? [ib.replyToSeq] : [])]) {
          const src = msgs.find((x) => x.seq === q);
          if (src && !src.retracted && src.seq <= cur && !inRanges(rewound, src.seq) && !pointers.some((p) => p.ref === `${r.id} #${q}`)) pointers.push({ ref: `${r.id} #${q}`, text: src.text });
        }
      }
    }
    const inbox = this.inbox(contactId);
    for (const i of inbox) fresh.push(JSON.parse(i.payload) as Inbound);
    if (fresh.length === 0) {
      if (ownOnly.length) tx(this.db, () => this.advanceCursorsTx(contactId, lastSeen));
      return "done";
    }
    const roundId = `${contactId}:r${++this.roundNo}:${Date.now().toString(36)}`;
    // 接走即已读(AC-46 ④):开始这一轮就推进已读位置,与 processed_seq 无关
    for (const r of rooms) if (fresh.some((f) => f.kind === "message" && f.roomId === r.id)) this.markRead(r.id, { kind: "contact", id: contactId }, lastSeen[r.id] ?? 0);
    const focusRoom = fresh.find((f) => f.kind === "message")?.roomId ?? fresh[0]?.roomId ?? null;
    this.setActivity(contactId, focusRoom, "thinking");
    const tasks = this.listTasks({ contactId }).filter((t) => !TERMINAL.has(t.state));
    const note = getDoc<{ text: string }>(this.db, `note:${contactId}`);
    const ledgerLines = this.activeLedgerLines(contactId);
    const freshKeys = new Set(fresh.flatMap((f) => (f.kind === "message" ? [`${f.roomId}#${f.seq}`, ...(f.replyToSeq !== null ? [`${f.roomId}#${f.replyToSeq}`] : [])] : [])));
    const freshTasks = new Set(fresh.flatMap((f) => (f.kind === "compute" ? [f.taskId] : [])));
    const request = this.assemble({
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
    });
    let out: Awaited<ReturnType<ContactMind["round"]>>;
    try {
      out = await this.opts.mind(this.contactView(contact)).round({ contact: { id: contactId, name: contact.name, speakingModel: contact.speakingModel, persona: contact.persona }, request, fresh }, signal);
    } catch (e) {
      this.setActivity(contactId, null, "idle");
      throw e;
    }
    if (signal.aborted || this.closed) return "done";
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
    const done = this.commitRound(contactId, contact, roundId, fresh, inbox, lastSeen, out);
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
            const commit = `result:${t.task.computeId}`;
            // 交付是普通消息(AC-56/U98):回复来源消息、@ 提出者,不挂验收卡;用户用普通回复表达通过或修改,由联系人提交 verdict。
            // 审查门(AC-26):还没有跨厂商审查联系人时任务停在 T5,提出者本人回复通过即豁免审查并验收,记为 waived-by-user
            const r = this.appendMessageTx(t.roomId, { kind: "contact", id: contactId }, {
              text: a.text,
              actionKey: actionId,
              replyToSeq: t.sourceSeq,
              quotedSeqs: [t.sourceSeq],
              mentions: [{ id: t.task.requester, source: "auto" }],
            });
            this.stepTaskTx(a.taskId, { kind: "SubmitForReview", commit, computeId: t.task.computeId, constraintVer: t.task.constraintVer }, { result: a.text, deliveredSeq: r.seq });
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
      if (out.stateNote !== null) {
        const cur = getDoc<{ text: string }>(this.db, `note:${contactId}`);
        putDoc(this.db, `note:${contactId}`, cur?.ver ?? 0, { text: out.stateNote });
      }
      for (const r of rejected) {
        run(this.db, "INSERT OR REPLACE INTO gg_effects (action_id, kind, payload, status, error, created_at) VALUES (?, ?, ?, 'rejected', ?, ?)", `${roundId}:rej:${rejected.indexOf(r)}`, r.action.kind, JSON.stringify(r.action), r.reason, this.now());
      }
    });
    for (const r of rejected) this.report("action-rejected", { contactId, ...r });
    for (const a of appended) this.afterAppend(a.roomId, a.seq, { kind: "contact", id: contactId });
    for (const id of touchedTasks) this.emitTask(id);
    return { effects };
  }

  // ======================= Compute =======================
  private adapterFor(model: string): ComputeAdapter | null {
    if (!this.opts.compute) return null;
    let a = this.adapters.get(model);
    if (!a) {
      a = this.opts.compute(model);
      this.adapters.set(model, a);
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
    const row = one<{ task_id: string; contact_id: string; room_id: string }>(this.db, "SELECT task_id, contact_id, room_id FROM gg_compute WHERE compute_id = ?", ev.computeId);
    if (!row) return;
    const at = this.now();
    const summary =
      ev.kind === "started" ? "已开始" : ev.kind === "milestone" ? ev.summary : ev.kind === "blocked" ? `受阻:${ev.needs}。${ev.summary}` : ev.kind === "completed" ? ev.result : ev.kind === "failed" ? `失败:${ev.reason}` : "已停止";
    const stage = ev.kind === "milestone" ? ev.stage : null;
    let taskChanged = false;
    tx(this.db, () => {
      run(this.db, "INSERT INTO gg_progress (task_id, compute_id, kind, stage, summary, at) VALUES (?, ?, ?, ?, ?, ?)", row.task_id, ev.computeId, ev.kind, stage, summary, at);
      const status = ev.kind === "started" || ev.kind === "milestone" ? "running" : ev.kind;
      run(this.db, "UPDATE gg_compute SET status = ?, ended_at = CASE WHEN ? IN ('completed','failed','stopped') THEN ? ELSE ended_at END, result = CASE WHEN ? = 'completed' THEN ? ELSE result END WHERE compute_id = ?", status, ev.kind, at, ev.kind, summary, ev.computeId);
      if (ev.kind === "failed") {
        const t = this.taskDoc(row.task_id).value.task;
        if (t.computeId === ev.computeId && !TERMINAL.has(t.state) && t.state !== "T9_StopRequested") {
          this.stepTaskTx(row.task_id, { kind: "ExecFailed", computeId: ev.computeId });
          taskChanged = true;
        }
      }
      // 实例已停(stopped)或失败退出:在等停止确认的任务据此确认,落到 T10/T11
      if (ev.kind === "failed" || ev.kind === "stopped") {
        const t = this.taskDoc(row.task_id).value.task;
        if (t.state === "T9_StopRequested" && (t.computeId === ev.computeId || t.orphans.includes(ev.computeId))) {
          this.stepTaskTx(row.task_id, { kind: "StoppedConfirmed", taskId: row.task_id, computeId: ev.computeId });
          taskChanged = true;
        }
      }
      if (ev.kind !== "started") {
        const payload: Inbound = { kind: "compute", roomId: row.room_id, taskId: row.task_id, computeId: ev.computeId, signal: ev.kind, summary, at };
        run(this.db, "INSERT INTO gg_inbox (contact_id, room_id, payload, at) VALUES (?, ?, ?, ?)", row.contact_id, row.room_id, JSON.stringify(payload), at);
      }
    });
    const progress: ComputeProgress = { computeId: ev.computeId, taskId: row.task_id, kind: ev.kind, ...(stage ? { stage } : {}), summary, at };
    this.bus.emit({ type: "compute.progress", progress });
    this.emitTask(row.task_id);
    if (taskChanged) this.emitTask(row.task_id);
    if (ev.kind !== "started") this.loop.notify(row.contact_id, ev.kind === "milestone" ? "batch" : "now");
  }

  private async runEffects(effects: HostEffect[]) {
    for (const e of effects) {
      try {
        if (e.kind === "spawn") await this.spawn(e);
        else if (e.kind === "resume") {
          const a = this.adapterForCompute(e.computeId);
          const r = a ? await a.resume(e.computeId, e.text) : { ok: false as const, reason: "没有 Compute 适配器" };
          if (!r.ok) this.report("resume-failed", { ...e, reason: r.reason });
        } else if (e.kind === "stop") {
          const a = this.adapterForCompute(e.computeId);
          if (a) await a.stop(e.computeId);
        }
      } catch (err) {
        this.report(`effect-${e.kind}`, err);
      }
    }
  }
  private adapterForCompute(computeId: string): ComputeAdapter | null {
    const row = one<{ model: string }>(this.db, "SELECT model FROM gg_compute WHERE compute_id = ?", computeId);
    return row ? this.adapterFor(row.model) : null;
  }
  private async spawn(e: Extract<HostEffect, { kind: "spawn" }>) {
    const adapter = this.adapterFor(e.model);
    const fail = (reason: string) => {
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
    if (!adapter) return fail("宿主没有配置 Compute 适配器");
    const cwd = this.opts.computeCwd?.(e.taskId);
    const tools = [...(this.opts.computeTools ?? DEFAULT_COMPUTE_TOOLS)];
    const r = await adapter.spawn({ task: e.brief, rules: [], tools, credentialRefs: [], placement: "local" }, cwd ? { cwd } : {});
    if (!r.ok) return fail(r.reason);
    const late: string[] = [];
    tx(this.db, () => {
      run(this.db, "INSERT INTO gg_compute (compute_id, task_id, contact_id, room_id, harness, model, status, started_at) VALUES (?, ?, ?, ?, 'claude-code', ?, 'starting', ?)", r.computeId, e.taskId, e.contactId, e.roomId, e.model, this.now());
      const { effects: eff } = this.stepTaskTx(e.taskId, { kind: "Dispatch", computeId: r.computeId, model: e.model, requestId: e.requestId });
      for (const x of eff) if (x.kind === "stop-compute") late.push(x.computeId);
    });
    this.emitTask(e.taskId);
    // 启动途中任务已被取消(如私聊 rewind):实例一上线就停,等它回报 stopped 再落 T10,不让它带着作废的请求跑下去
    for (const id of late) await adapter.stop(id);
  }

  // ======================= 卡片与验收 =======================
  /** 用户点卡片按钮;以对话消息形式记录(决策是共享上下文)。 */
  cardAct(input: { roomId: string; seq: number; cardId: string; actionId: string; clientActionId: string; text?: string }): MessageView {
    const card = one<CardRow>(this.db, "SELECT * FROM gg_cards WHERE card_id = ?", input.cardId);
    if (!card || card.room_id !== input.roomId || card.seq !== input.seq) throw new HostError("not_found", "卡片不存在");
    const actions = JSON.parse(card.actions) as { actionId: string; label: string }[];
    const act = actions.find((a) => a.actionId === input.actionId);
    if (!act) throw new HostError("invalid_params", `卡片没有动作 ${input.actionId}`);
    // CAS 领取:open → claimed,连点只有第一次生效(AC-36 ⑤)
    if (run(this.db, "UPDATE gg_cards SET state = 'claimed' WHERE card_id = ? AND state = 'open'", input.cardId) !== 1) throw new HostError("conflict", "这张卡已经处理过了");
    const me: Member = { kind: "user", id: this.userId };
    let msgSeq = 0;
    const effects: HostEffect[] = [];
    try {
      tx(this.db, () => {
        const text = input.text?.trim() ? `${act.label}:${input.text.trim()}` : act.label;
        msgSeq = this.appendMessageTx(card.room_id, me, { text, actionKey: `user:${input.clientActionId}`, clientActionId: input.clientActionId, replyToSeq: card.seq, quotedSeqs: [card.seq] }).seq;
        if (card.task_id) effects.push(...this.applyCardDecisionTx(card, input.actionId, input.text ?? ""));
        run(this.db, "UPDATE gg_cards SET state = 'done' WHERE card_id = ?", input.cardId);
      });
    } catch (e) {
      run(this.db, "UPDATE gg_cards SET state = 'open' WHERE card_id = ? AND state = 'claimed'", input.cardId);
      throw e;
    }
    this.markRead(card.room_id, me, msgSeq);
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

  // ======================= 生命周期 =======================
  async idle(): Promise<void> {
    await this.loop.idle();
  }
  async close(): Promise<void> {
    this.closed = true;
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

/** 已交付、等提出者回复的任务(AC-56 普通消息交付):T8a,或还没有审查人、停在 T5 等本人豁免。旧数据(交付卡)不算,走卡片。 */
function awaitingUser(d: TaskDoc): boolean {
  if (d.deliveredSeq == null) return false;
  return d.task.state === "T8a_Delivered" || d.task.state === "T5_InReview";
}

type HostEffect =
  | { kind: "spawn"; taskId: string; requestId: string; contactId: string; model: string; brief: string; roomId: string }
  | { kind: "resume"; taskId: string; computeId: string; text: string }
  | { kind: "stop"; taskId: string; computeId: string };
