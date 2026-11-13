// 群聊动向摘要(U80,D21.2–D21.4):联系人按承诺每 N 条消息读一段固定区间 (from, to],写一份带来源的解读。
// - 只读桥:到点由宿主把这段当前可见的群聊发言交给联系人模型的现有入口(ContactMind.round,模型就是它的说话模型),
//   只收它的要点;它提出的任何动作都不执行。摘要只写 gg_summaries 自己的记录:不发消息、不动任务/授权/卡片/草稿/已读与处理游标。
// - 区间固定:from、to 在冻结窗口时就定了,宿主把整段读全(没有 200 条快照那种上限);超过输入字节上限只给前一部分,如实记 truncated。
//   区间里没有可总结的发言(全是通知/任务卡,或全被撤回、被提出人在自己这端删了)记 empty,不调模型。
// - 失效(AC-08):区间里有消息被撤回,这段的摘要对所有人标 stale(原因、是哪条 seq),正文当场清掉——和撤回在同一个事务里落盘,
//   不靠内存事件;生成途中撤回的,模型回来落库前在同一个事务里复核这段区间,有新撤回就直接落成 stale、正文不存。
//   本端删除(只隐藏用户自己这一端)不改摘要记录,只在给那位用户的视图里去掉他已经删掉来源的要点。
//   过期或失败的可以重做:同一区间出新版本,指回旧版本。
// - 一个窗口宿主只自动调一次模型;失败、重启打断都记 failed,不在后台反复重试,要再来由用户重做。
import { recordAction } from "@g-group/adapter-sqlite";
import type { TrendSummaryView } from "@g-group/api-contract";
import type { ContactMind, ContactProfile } from "@g-group/kernel";
import { type ChatLine, chatLines, retractedSeqs } from "./chat-range.ts";
import type { CountWindow } from "./count-triggers.ts";
import { type Db, HostError, all, one, run, tx } from "./db.ts";
import { type SummaryItem, fitLines, parseSummary, summaryRequest } from "./trend-summary-format.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS gg_summaries (
  id TEXT PRIMARY KEY, room_id TEXT NOT NULL, contact_id TEXT NOT NULL, requester_id TEXT NOT NULL, commitment_id TEXT NOT NULL, trigger_id TEXT NOT NULL,
  from_seq INTEGER NOT NULL, to_seq INTEGER NOT NULL, version INTEGER NOT NULL, supersedes TEXT,
  status TEXT NOT NULL, items TEXT NOT NULL, message_count INTEGER NOT NULL, covered_count INTEGER NOT NULL, covered_to_seq INTEGER, truncated INTEGER NOT NULL,
  model TEXT NOT NULL, generated_at TEXT, stale_reason TEXT, stale_by_seq INTEGER, stale_at TEXT, error TEXT, created_at TEXT NOT NULL,
  UNIQUE (room_id, contact_id, from_seq, to_seq, version)
);
CREATE INDEX IF NOT EXISTS gg_summaries_room ON gg_summaries (room_id, to_seq);
`;

/** 视图就是合同里的 TrendSummaryView(字段说明在那里)。 */
export type TrendSummary = TrendSummaryView;
export type SummaryStatus = TrendSummaryView["status"];
/** 交给模型的消息原文的 UTF-8 字节上限(默认值;宿主可用 summaryInputMaxBytes 改)。超了只给前一部分并标 truncated。 */
export const SUMMARY_INPUT_MAX_BYTES = 300_000;
/** 一次摘要等模型多久(毫秒,默认值;宿主可用 summaryTimeoutMs 改)。到时中止,记 failed。 */
export const SUMMARY_TIMEOUT_MS = 300_000;
const ERROR_MAX = 2000;

export interface TrendSummaryDeps {
  readonly db: Db;
  readonly now: () => string;
  readonly newId: (prefix: string) => string;
  /** 这位联系人现在的档案与脑子;已删除返回 null。脑子必须就是它平时说话用的那个入口,不另配模型或密钥。 */
  readonly contact: (contactId: string) => { profile: ContactProfile; mind: ContactMind } | null;
  /** 它现在还能不能在这个会话里做摘要(不在群里、正在移出、群已解散给出原因)。 */
  readonly blockedWhy: (contactId: string, roomId: string) => string | null;
  readonly roomTitle: (roomId: string) => string;
  readonly nameOf: (sender: { kind: string; id: string }) => string;
  readonly hidden: (roomId: string, viewerId: string) => (seq: number) => boolean;
  /** 承诺原文(给模型看是哪条承诺引出的);查不到为 null。 */
  readonly commitmentText: (commitmentId: string, contactId: string, roomId: string) => string | null;
  /** 窗口还在等处理吗。 */
  readonly windowPending: (triggerId: string, toSeqInclusive: number) => boolean;
  /** 窗口处理完(在摘要落盘的同一事务里调用)。 */
  readonly settleWindowTx: (triggerId: string, toSeqInclusive: number, status: "done" | "failed") => void;
  /** 提交之后:某份摘要新建或状态变了。 */
  readonly changed: (summaryId: string) => void;
  readonly report: (what: string, detail: unknown) => void;
  readonly inputMaxBytes?: number;
  readonly timeoutMs?: number;
}

interface Row {
  id: string;
  room_id: string;
  contact_id: string;
  requester_id: string;
  commitment_id: string;
  /** 引出它的那个冻结窗口所属的触发;重做出来的新版本沿用 */
  trigger_id: string;
  from_seq: number;
  to_seq: number;
  version: number;
  supersedes: string | null;
  status: SummaryStatus;
  items: string;
  message_count: number;
  covered_count: number;
  covered_to_seq: number | null;
  truncated: number;
  model: string;
  generated_at: string | null;
  stale_reason: "source-retracted" | null;
  stale_by_seq: number | null;
  stale_at: string | null;
  error: string | null;
  created_at: string;
}
/**
 * 平常轮的承诺账本里,跟在「每 N 条消息」那条承诺 id 后面的一句(一行索引里也看得到):到点由宿主另起一轮把那一段交给它写摘要,
 * 它不用(也不要)在平常轮里自己往会话里发总结——否则同一段既有时间轴上的摘要、又多一条聊天消息,那条消息还会被数进下一段。
 */
export const summaryLedgerNote = (everyN: number) => `每 ${everyN} 条消息一次(宿主替你数,到点另起一轮把那一段交给你写摘要;平常轮不要自己在会话里发总结)`;
/** 区间 (from, to] 含不含这条 seq。撤回失效与落库前复核都只用这一条判。 */
const covers = (r: { from_seq: number; to_seq: number }, seq: number) => r.from_seq < seq && seq <= r.to_seq;
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, ERROR_MAX);

export class TrendSummaries {
  private readonly d: TrendSummaryDeps;
  private chain: Promise<void> = Promise.resolve();
  private queued = 0;
  private closed = false;
  private current: AbortController | null = null;
  /** 事务里状态变了、提交后要通知的摘要 */
  private readonly dirty = new Set<string>();
  constructor(deps: TrendSummaryDeps) {
    this.d = deps;
    deps.db.store.db.exec(SCHEMA);
  }

  private row(id: string): Row {
    const r = one<Row>(this.d.db, "SELECT * FROM gg_summaries WHERE id = ?", id);
    if (!r) throw new HostError("not_found", `没有摘要 ${id}`);
    return r;
  }
  /** 给某位用户看的视图:他在自己这一端删掉的来源不再给跳转,来源全被他删掉的要点不显示。记录本身不因此改变。 */
  view(id: string, viewerId: string): TrendSummary {
    return this.toView(this.row(id), viewerId);
  }
  private toView(r: Row, viewerId: string): TrendSummary {
    const hidden = this.d.hidden(r.room_id, viewerId);
    const all_ = (JSON.parse(r.items) as SummaryItem[]).map((it) => ({ text: it.text, sourceSeqs: [...it.sourceSeqs], hiddenSourceSeqs: it.sourceSeqs.filter((q) => hidden(q)) }));
    const items = all_.filter((it) => it.hiddenSourceSeqs.length < it.sourceSeqs.length);
    return {
      summaryId: r.id,
      roomId: r.room_id,
      contactId: r.contact_id,
      commitmentId: r.commitment_id,
      nature: "llm-interpretation",
      fromSeqExclusive: r.from_seq,
      toSeqInclusive: r.to_seq,
      messageCount: r.message_count,
      coveredCount: r.covered_count,
      coveredToSeq: r.covered_to_seq,
      truncated: !!r.truncated,
      status: r.status,
      items,
      hiddenItems: all_.length - items.length,
      model: JSON.parse(r.model) as { speakingModel: string },
      generatedAt: r.generated_at,
      staleReason: r.stale_reason,
      staleBySeq: r.stale_by_seq,
      staleAt: r.stale_at,
      error: r.error,
      version: r.version,
      supersedes: r.supersedes,
      supersededBy: one<{ id: string }>(this.d.db, "SELECT id FROM gg_summaries WHERE supersedes = ?", r.id)?.id ?? null,
      createdAt: r.created_at,
    };
  }
  /** 一个会话的摘要,按区间从新到旧;默认每段只给最新版本。beforeToSeq 翻页。 */
  list(q: { roomId: string; viewerId: string; beforeToSeq?: number; includeSuperseded?: boolean; limit?: number }): { summaries: TrendSummary[]; hasMore: boolean } {
    const limit = q.limit ?? 50;
    const rows = all<Row>(
      this.d.db,
      `SELECT s.* FROM gg_summaries s WHERE s.room_id = ? AND s.to_seq < ?${q.includeSuperseded ? "" : " AND NOT EXISTS (SELECT 1 FROM gg_summaries n WHERE n.supersedes = s.id)"} ORDER BY s.to_seq DESC, s.contact_id, s.version DESC LIMIT ?`,
      q.roomId,
      q.beforeToSeq ?? Number.MAX_SAFE_INTEGER,
      limit + 1,
    );
    return { summaries: rows.slice(0, limit).map((r) => this.toView(r, q.viewerId)), hasMore: rows.length > limit };
  }

  // ---------- 生成 ----------
  /** 触发冻结了一个窗口:排队生成(一个一个来)。 */
  enqueue(w: CountWindow): void {
    this.push(() => this.runWindow(w));
  }
  private push(job: () => Promise<void>) {
    this.queued++;
    this.chain = this.chain
      .then(job)
      .catch((e) => this.d.report("summary-error", { error: errorText(e) }))
      .finally(() => {
        this.queued--;
      });
  }
  busy(): boolean {
    return this.queued > 0;
  }
  async idle(): Promise<void> {
    while (this.queued > 0) await this.chain;
  }
  private insertTx(i: { roomId: string; contactId: string; requesterId: string; commitmentId: string; triggerId: string; from: number; to: number; supersedes: string | null; model: string }): string {
    const id = this.d.newId("sum");
    const version = (one<{ v: number | null }>(this.d.db, "SELECT max(version) AS v FROM gg_summaries WHERE room_id = ? AND contact_id = ? AND from_seq = ? AND to_seq = ?", i.roomId, i.contactId, i.from, i.to)?.v ?? 0) + 1;
    run(
      this.d.db,
      "INSERT INTO gg_summaries (id, room_id, contact_id, requester_id, commitment_id, trigger_id, from_seq, to_seq, version, supersedes, status, items, message_count, covered_count, covered_to_seq, truncated, model, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'generating', '[]', 0, 0, NULL, 0, ?, ?)",
      id,
      i.roomId,
      i.contactId,
      i.requesterId,
      i.commitmentId,
      i.triggerId,
      i.from,
      i.to,
      version,
      i.supersedes,
      JSON.stringify({ speakingModel: i.model }),
      this.d.now(),
    );
    return id;
  }
  private async runWindow(w: CountWindow): Promise<void> {
    if (this.closed) return;
    const model = this.d.contact(w.contactId)?.profile.speakingModel ?? "";
    const id = tx(this.d.db, () => {
      // 窗口已被取消或处理过:不再生成
      if (!this.d.windowPending(w.triggerId, w.toSeqInclusive)) return null;
      return this.insertTx({ roomId: w.roomId, contactId: w.contactId, requesterId: w.requesterId, commitmentId: w.commitmentId, triggerId: w.triggerId, from: w.fromSeqExclusive, to: w.toSeqInclusive, supersedes: null, model });
    });
    if (id === null) return;
    this.d.changed(id);
    await this.generate(id);
  }
  /** 把一条 generating 记录落成最终状态;窗口同一事务结清。 */
  private finishTx(r: Row, set: { status: "ok" | "empty" | "failed"; items?: readonly SummaryItem[]; messageCount?: number; covered?: readonly ChatLine[]; error?: string }): void {
    const covered = set.covered ?? [];
    const messageCount = set.messageCount ?? 0;
    run(
      this.d.db,
      "UPDATE gg_summaries SET status = ?, items = ?, message_count = ?, covered_count = ?, covered_to_seq = ?, truncated = ?, generated_at = ?, error = ? WHERE id = ?",
      set.status,
      JSON.stringify(set.status === "ok" ? (set.items ?? []) : []),
      messageCount,
      covered.length,
      covered.at(-1)?.seq ?? null,
      covered.length < messageCount ? 1 : 0,
      set.status === "failed" ? null : this.d.now(),
      set.error?.slice(0, ERROR_MAX) ?? null,
      r.id,
    );
    // 窗口只在还等着处理时才会被结清;重做出来的新版本再走到这里不改窗口
    this.d.settleWindowTx(r.trigger_id, r.to_seq, set.status === "failed" ? "failed" : "done");
  }
  private finish(r: Row, set: Parameters<TrendSummaries["finishTx"]>[1]): void {
    tx(this.d.db, () => this.finishTx(r, set));
    this.d.changed(r.id);
  }
  /** 读区间 → 调一次联系人模型 → 校验来源 → 落盘。任何一步不成都落成 failed 或 empty,不留 generating。 */
  private async generate(id: string): Promise<void> {
    const r = this.row(id);
    if (r.status !== "generating") return;
    const who = this.d.contact(r.contact_id);
    const blocked = who ? this.d.blockedWhy(r.contact_id, r.room_id) : "联系人已删除";
    if (!who || blocked) return this.finish(r, { status: "failed", error: blocked ?? "联系人已删除" });
    const lines = chatLines(this.d.db, { roomId: r.room_id, afterSeq: r.from_seq, uptoSeq: r.to_seq, hidden: this.d.hidden(r.room_id, r.requester_id) });
    const retractedBefore = new Set(retractedSeqs(this.d.db, r.room_id));
    // 没有可总结的群聊发言:明说,不调模型
    if (lines.length === 0) return this.finish(r, { status: "empty" });
    const covered = fitLines(lines, this.d.inputMaxBytes ?? SUMMARY_INPUT_MAX_BYTES);
    if (covered.length === 0) return this.finish(r, { status: "failed", messageCount: lines.length, error: "区间里第一条消息就超过了摘要输入上限" });
    const { request, fresh } = summaryRequest({
      contact: who.profile,
      roomId: r.room_id,
      roomTitle: this.d.roomTitle(r.room_id),
      fromSeqExclusive: r.from_seq,
      toSeqInclusive: r.to_seq,
      lines: covered.map((l) => ({ ...l, senderName: this.d.nameOf(l.sender) })),
      messageCount: lines.length,
      commitmentText: this.d.commitmentText(r.commitment_id, r.contact_id, r.room_id),
    });
    const ac = new AbortController();
    this.current = ac;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let out: Awaited<ReturnType<ContactMind["round"]>>;
    try {
      const late = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error("等模型超时"));
          ac.abort();
        }, this.d.timeoutMs ?? SUMMARY_TIMEOUT_MS);
        ac.signal.addEventListener("abort", () => reject(new Error("已中止")), { once: true });
      });
      late.catch(() => {});
      out = await Promise.race([who.mind.round({ contact: who.profile, request, fresh }, ac.signal), late]);
    } catch (e) {
      // 宿主关闭:记录留在 generating,下次启动记成被打断
      if (this.closed) return;
      return this.finish(r, { status: "failed", messageCount: lines.length, covered, error: `模型调用没成:${errorText(e)}` });
    } finally {
      clearTimeout(timer);
      this.current = null;
    }
    // 只读:只收它在这个会话里说的要点,别的动作一概不执行(记一笔便于核对)
    const ignored = out.actions.filter((a) => !(a.kind === "reply" && a.roomId === r.room_id)).map((a) => a.kind);
    if (ignored.length || out.stateNote !== null) this.d.report("summary-actions-ignored", { summaryId: id, kinds: ignored, stateNote: out.stateNote !== null });
    const parsed = parseSummary(out.actions.flatMap((a) => (a.kind === "reply" && a.roomId === r.room_id ? [a.text] : [])), new Set(covered.map((l) => l.seq)));
    if (!parsed.ok) return this.finish(r, { status: "failed", messageCount: lines.length, covered, error: parsed.reason });
    tx(this.d.db, () => {
      // 落库前复核(和落库同一事务):生成期间这段区间里有没有消息被撤回。有就不存正文,直接落成过期
      const gone = retractedSeqs(this.d.db, r.room_id).find((q) => covers(r, q) && !retractedBefore.has(q));
      if (gone === undefined) return this.finishTx(r, { status: "ok", items: parsed.items, messageCount: lines.length, covered });
      this.staleTx(r.id, gone);
      this.d.settleWindowTx(r.trigger_id, r.to_seq, "done");
    });
    this.dirty.add(id);
    this.announce();
  }

  // ---------- 失效与重做 ----------
  /** 把一份摘要标过期:记原因与触发的那条 seq,正文清空(撤回的原文不能经旧摘要留下来)。 */
  private staleTx(id: string, seq: number): void {
    run(this.d.db, "UPDATE gg_summaries SET status = 'stale', items = '[]', stale_reason = 'source-retracted', stale_by_seq = ?, stale_at = ? WHERE id = ?", seq, this.d.now(), id);
    this.dirty.add(id);
  }
  /**
   * 会话里 #seq 被撤回(在写撤回事件的同一事务里调用):区间 (from, to] 含它的已生成摘要标 stale。返回被标掉的摘要 id。
   * 已经过期的不再改(原因留第一次的);失败的、空的本来就没有正文,不动。
   * 正在生成的不在这里动:它落库前自己复核(generate)。
   */
  invalidateTx(roomId: string, seq: number): string[] {
    const hit = all<Row>(this.d.db, "SELECT * FROM gg_summaries WHERE room_id = ? AND status = 'ok' ORDER BY to_seq, id", roomId)
      .filter((r) => covers(r, seq))
      .map((r) => r.id);
    for (const id of hit) this.staleTx(id, seq);
    return hit;
  }
  /** 事务提交之后调用:把刚标过期的摘要推出去。 */
  announce(): void {
    for (const id of [...this.dirty]) {
      this.dirty.delete(id);
      this.d.changed(id);
    }
  }
  /**
   * 重做一份过期或失败的摘要:同一区间出新版本(指回旧版本),重新读这段现在可见的消息。只有最新版本能重做;同一 clientActionId 重放返回同一份。
   */
  regenerate(input: { summaryId: string; clientActionId: string; viewerId: string }): TrendSummary {
    const key = `summary-regen:${input.summaryId}:${input.clientActionId}`;
    const prior = one<{ payload: string }>(this.d.db, "SELECT payload FROM actions WHERE action_id = ?", key);
    if (prior) return this.view((JSON.parse(prior.payload) as { id: string }).id, input.viewerId);
    const old = this.row(input.summaryId);
    if (old.status !== "stale" && old.status !== "failed") throw new HostError("conflict", `这份摘要是 ${old.status},只有已过期或没生成成的才能重做`);
    if (one(this.d.db, "SELECT 1 FROM gg_summaries WHERE supersedes = ?", old.id)) throw new HostError("conflict", "这份摘要已经有更新的版本");
    const who = this.d.contact(old.contact_id);
    const blocked = who ? this.d.blockedWhy(old.contact_id, old.room_id) : "联系人已删除";
    if (!who || blocked) throw new HostError("conflict", `现在不能重做:${blocked ?? "联系人已删除"}`);
    const id = tx(this.d.db, () => {
      const made = this.insertTx({ roomId: old.room_id, contactId: old.contact_id, requesterId: old.requester_id, commitmentId: old.commitment_id, triggerId: old.trigger_id, from: old.from_seq, to: old.to_seq, supersedes: old.id, model: who.profile.speakingModel });
      recordAction(this.d.db.store, key, { id: made });
      return made;
    });
    this.d.changed(old.id);
    this.d.changed(id);
    this.push(() => this.generate(id));
    return this.view(id, input.viewerId);
  }

  // ---------- 生命周期 ----------
  /** 宿主启动时(在事务里调用):上次留下的 generating 是被打断的,记 failed 并结清它的窗口;不自动再调模型。 */
  recoverTx(): void {
    for (const r of all<Row>(this.d.db, "SELECT * FROM gg_summaries WHERE status = 'generating' ORDER BY created_at, id")) this.finishTx(r, { status: "failed", error: "宿主重启,这次生成被打断;可以重做" });
  }
  /** 宿主关闭:中止在途的模型调用,等队列收尾。 */
  async stop(): Promise<void> {
    this.closed = true;
    this.current?.abort();
    await this.chain;
  }
}
