// 联系人自设定时与常驻承诺(U20「联系人可设自己的定时唤醒,群聊私聊都支持」、U80「每 N 条消息」作为承诺的触发方式、D04.2-1)。
// D02 窄接口的工具形态是候选(需求文档 §8.1 待决第 2 条),这里按 brief 最小做:
//   - 联系人只能管「自己在本会话」的定时;依据(sourceSeq)必须是本轮里用户本人的直接消息——别的联系人、Helper、
//     转发或只有引用块的内容不能让联系人设或改定时(AC-20);
//   - cron 定时落 Scheduler(时区一律显式:联系人没给就补成用户设置的时区);每 N 条消息落本文件的 gg_msg_triggers,
//     消息入库时按会话计数(只算用户与联系人的消息;宿主生成的卡片、Helper 旁白不算),满 N 条投递一次 InboundSchedule;
//   - 新设的定时/触发器同时在承诺账本里登记一条常驻承诺(taskId 为 standing-…),两边互相引用;承诺了结(撤销、回退)时
//     定时停用、触发器停计数;联系人删定时时承诺一起了结。
// 条件触发只占位,宿主暂不受理。
import type { InboundMessage, InboundSchedule, MindAction } from "@g-group/kernel";
import { type Db, HostError, all, one, run } from "./db.ts";
import { checkCron, cronText, type Scheduler } from "./schedules.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS gg_msg_triggers (
  id TEXT PRIMARY KEY, contact_id TEXT NOT NULL, room_id TEXT NOT NULL, every_n INTEGER NOT NULL, counted INTEGER NOT NULL DEFAULT 0,
  since_seq INTEGER NOT NULL, prompt TEXT NOT NULL, enabled INTEGER NOT NULL, commitment_id TEXT, source_seq INTEGER NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS gg_msg_triggers_room ON gg_msg_triggers (room_id, enabled);
`;
/** 每 N 条消息的上限(防误填一个天文数字后永远不触发又不报错) */
export const EVERY_N_MAX = 100_000;

interface TriggerRow {
  id: string;
  contact_id: string;
  room_id: string;
  every_n: number;
  counted: number;
  since_seq: number;
  prompt: string;
  enabled: number;
  commitment_id: string | null;
  source_seq: number;
  created_at: string;
}
export type ScheduleAction = Extract<MindAction, { kind: "schedule-set" | "schedule-pause" | "schedule-remove" }>;
export interface StandingDeps {
  readonly db: Db;
  readonly now: () => string;
  readonly newId: (p: string) => string;
  readonly userId: string;
  readonly scheduler: Scheduler;
  /** 用户设置的时区(联系人没给 tz 时补成它) */
  readonly timezone: () => string;
  /** 账本里这条承诺此刻的状态与任务号;没有为 null */
  readonly commitment: (contactId: string, roomId: string, commitmentId: string) => { readonly status: string; readonly taskId: string } | null;
  /** 联系人此刻是这个会话的成员(不在移出中) */
  readonly member: (contactId: string, roomId: string) => boolean;
}
export type StandingOutcome =
  | { readonly ok: false; readonly reason: string }
  | {
      readonly ok: true;
      /** 要在账本里以来源消息登记的常驻承诺 */
      readonly propose: { readonly id: string; readonly taskId: string; readonly text: string } | null;
      /** 要了结的常驻承诺(联系人删了定时) */
      readonly close: { readonly commitmentId: string; readonly taskId: string; readonly detail: string } | null;
      /** 事务提交后执行(推定时视图、重设计时器) */
      readonly after: () => void;
    };

/** 用户本人的话:去掉引用块(> 开头的行)与代码块——那是转发或引用的别人的内容(AC-20)。 */
export function ownWords(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .split(/\r?\n/)
    .filter((l) => !/^\s*[>＞]/.test(l))
    .join("\n");
}

type Own = { readonly kind: "cron"; readonly id: string; readonly commitmentId: string | null } | { readonly kind: "every_n"; readonly row: TriggerRow };

export class StandingCommitments {
  private readonly d: StandingDeps;
  private notifyQ = new Set<string>();
  private changedQ = new Set<string>();
  constructor(deps: StandingDeps) {
    this.d = deps;
    deps.db.store.db.exec(SCHEMA);
  }
  private trigger(id: string): TriggerRow | undefined {
    return one<TriggerRow>(this.d.db, "SELECT * FROM gg_msg_triggers WHERE id = ?", id);
  }
  /** 找联系人自己在本会话的那条定时/触发器;别人的、别的会话的、没有的给出原因 */
  private own(contactId: string, roomId: string, id: string): Own | string {
    const s = this.d.scheduler.get(id);
    const t = s ? undefined : this.trigger(id);
    const owner = s?.contact_id ?? t?.contact_id;
    const room = s?.room_id ?? t?.room_id;
    if (owner === undefined) return `没有这条定时 ${id}`;
    if (owner !== contactId) return "不是你的定时";
    if (room !== roomId) return "这条定时不在本会话,只能管本会话里的";
    return s ? { kind: "cron", id, commitmentId: this.d.scheduler.commitmentOf(id) } : { kind: "every_n", row: t! };
  }
  private active(contactId: string, roomId: string, commitmentId: string | null): { id: string; taskId: string } | null {
    if (commitmentId === null) return null;
    const c = this.d.commitment(contactId, roomId, commitmentId);
    return c && c.status === "active" ? { id: commitmentId, taskId: c.taskId } : null;
  }

  /**
   * 事务内校验并执行一个定时动作。依据必须是本轮新消息里用户本人的直接消息;只能动自己在本会话的定时。
   * 不合格返回原因(不改任何东西);合格时返回要登记/了结的常驻承诺,由宿主写进同一事务的承诺账本。
   */
  applyTx(contactId: string, a: ScheduleAction, fresh: readonly InboundMessage[]): StandingOutcome {
    const no = (reason: string): StandingOutcome => ({ ok: false, reason });
    const src = fresh.find((m) => m.roomId === a.roomId && m.seq === a.sourceSeq);
    if (!src) return no(`来源 ${a.roomId} #${a.sourceSeq} 不是本轮新消息`);
    if (src.sender.kind !== "user" || src.sender.id !== this.d.userId) return no(`来源 ${a.roomId} #${a.sourceSeq} 不是用户本人的消息:别的联系人、Helper 与外部内容不能让你设或改定时`);
    if (!ownWords(src.text).trim()) return no(`来源 ${a.roomId} #${a.sourceSeq} 只有引用或转发的内容,不是用户本人的话`);
    const commitText = (text: string) => (src.text.includes(text) ? text : src.text.trim().slice(0, 5000));
    const propose = (text: string) => {
      const id = this.d.newId("k");
      return { id, taskId: `standing-${id}`, text: commitText(text) };
    };
    if (a.kind === "schedule-set") {
      const text = a.text.trim();
      if (!text) return no("到点要做的事是空的");
      const t = a.trigger;
      if (t.kind === "condition") return no("条件触发还没开放(只占位),现在只受理 cron 定时和每 N 条消息");
      let tz = "";
      if (t.kind === "cron") {
        tz = t.tz ?? this.d.timezone();
        try {
          checkCron(t.cron, tz);
        } catch (e) {
          return no(e instanceof HostError ? e.message : String(e));
        }
      } else if (!Number.isSafeInteger(t.n) || t.n < 1 || t.n > EVERY_N_MAX) return no(`每 N 条消息的 N 要是 1–${EVERY_N_MAX} 的整数`);
      if (a.scheduleId === null) {
        const k = propose(a.text);
        if (t.kind === "cron") {
          const id = this.d.scheduler.insertTx({ contactId, roomId: a.roomId, title: text.slice(0, 40), cron: t.cron, tz, prompt: text }, { commitmentId: k.id, sourceRoom: a.roomId, sourceSeq: src.seq });
          return { ok: true, propose: k, close: null, after: () => this.d.scheduler.changed(id) };
        }
        const id = this.d.newId("trg");
        run(
          this.d.db,
          "INSERT INTO gg_msg_triggers (id, contact_id, room_id, every_n, counted, since_seq, prompt, enabled, commitment_id, source_seq, created_at) VALUES (?, ?, ?, ?, 0, ?, ?, 1, ?, ?, ?)",
          id,
          contactId,
          a.roomId,
          t.n,
          src.seq,
          text,
          k.id,
          src.seq,
          this.d.now(),
        );
        return { ok: true, propose: k, close: null, after: () => {} };
      }
      const o = this.own(contactId, a.roomId, a.scheduleId);
      if (typeof o === "string") return no(o);
      if ((o.kind === "cron") !== (t.kind === "cron")) return no(`${a.scheduleId} 是${o.kind === "cron" ? " cron 定时" : "每 N 条消息的触发器"},不能改成另一种;先删再设`);
      // 原来的常驻承诺已了结(或是界面建的、没有承诺):这一次用户的直接要求另登记一条,重新挂上
      const linked = this.active(contactId, a.roomId, o.kind === "cron" ? o.commitmentId : o.row.commitment_id);
      const k = linked ? null : propose(a.text);
      if (o.kind === "cron" && t.kind === "cron") {
        this.d.scheduler.patchTx(o.id, { cron: t.cron, tz, prompt: text, title: text.slice(0, 40), enabled: true });
        if (k) this.d.scheduler.linkTx(o.id, k.id, { room: a.roomId, seq: src.seq });
        return { ok: true, propose: k, close: null, after: () => this.d.scheduler.changed(o.id) };
      }
      if (o.kind === "every_n" && t.kind === "every_n_messages") {
        run(this.d.db, "UPDATE gg_msg_triggers SET every_n = ?, prompt = ?, enabled = 1, commitment_id = ? WHERE id = ?", t.n, text, k?.id ?? o.row.commitment_id, o.row.id);
        return { ok: true, propose: k, close: null, after: () => {} };
      }
      return no("触发方式不一致");
    }
    const o = this.own(contactId, a.roomId, a.scheduleId);
    if (typeof o === "string") return no(o);
    if (a.kind === "schedule-pause") {
      if (o.kind === "cron") {
        this.d.scheduler.patchTx(o.id, { enabled: false });
        return { ok: true, propose: null, close: null, after: () => this.d.scheduler.changed(o.id) };
      }
      run(this.d.db, "UPDATE gg_msg_triggers SET enabled = 0 WHERE id = ?", o.row.id);
      return { ok: true, propose: null, close: null, after: () => {} };
    }
    const linked = this.active(contactId, a.roomId, o.kind === "cron" ? o.commitmentId : o.row.commitment_id);
    const close = linked ? { commitmentId: linked.id, taskId: linked.taskId, detail: `用户 #${src.seq} 要求删掉定时 ${a.scheduleId}` } : null;
    if (o.kind === "cron") {
      this.d.scheduler.deleteTx(o.id);
      return { ok: true, propose: null, close, after: () => this.d.scheduler.removed(o.id) };
    }
    run(this.d.db, "DELETE FROM gg_msg_triggers WHERE id = ?", o.row.id);
    return { ok: true, propose: null, close, after: () => {} };
  }

  /**
   * 事务内:一条消息入库后按会话计数(U80)。只算用户与联系人的消息;宿主生成的卡片、Helper 旁白不算。
   * 满 N 条恰好投递一次 InboundSchedule(运行记录同定时),计数清零;事务后由 takeNotify 叫醒联系人。
   */
  countTx(roomId: string, seq: number, sender: { readonly kind: string; readonly id: string }, f: { readonly card: boolean }): void {
    if (sender.kind !== "user" && sender.kind !== "contact") return;
    if (f.card) return;
    for (const t of all<TriggerRow>(this.d.db, "SELECT * FROM gg_msg_triggers WHERE room_id = ? AND enabled = 1 ORDER BY created_at, id", roomId)) {
      if (!this.d.member(t.contact_id, roomId)) continue;
      const counted = t.counted + 1;
      if (counted < t.every_n) {
        run(this.d.db, "UPDATE gg_msg_triggers SET counted = ? WHERE id = ?", counted, t.id);
        continue;
      }
      run(this.d.db, "UPDATE gg_msg_triggers SET counted = 0, since_seq = ? WHERE id = ?", seq, t.id);
      const at = this.d.now();
      const inbound: InboundSchedule = { kind: "schedule", roomId, scheduleId: t.id, prompt: `(本会话 #${t.since_seq + 1}–#${seq} 又到了 ${t.every_n} 条消息)${t.prompt}`, at };
      this.d.scheduler.deliverRunTx(t.id, t.contact_id, roomId, inbound, at);
      this.notifyQ.add(t.contact_id);
    }
  }
  /** 事务后:取走要叫醒的联系人(计数触发了的) */
  takeNotify(): string[] {
    const out = [...this.notifyQ];
    this.notifyQ.clear();
    return out;
  }
  /** 事务内:一条承诺了结(撤销、回退、完成)——对应的定时停用、触发器停计数 */
  closedTx(commitmentId: string): void {
    for (const id of this.d.scheduler.disableByCommitmentTx(commitmentId)) this.changedQ.add(id);
    run(this.d.db, "UPDATE gg_msg_triggers SET enabled = 0 WHERE commitment_id = ?", commitmentId);
  }
  /** 事务后:取走因承诺了结而停用的定时(逐个推视图) */
  takeChanged(): string[] {
    const out = [...this.changedQ];
    this.changedQ.clear();
    return out;
  }

  private lines(contactId: string, roomIds: readonly string[]): string[] {
    const rooms = new Set(roomIds);
    const out: string[] = [];
    for (const s of this.d.scheduler.list({ contactId, order: "created" })) {
      if (!rooms.has(s.roomId)) continue;
      const last = s.lastRun ? ` 最近 ${s.lastRun.status}${s.lastRun.messageSeq === null ? "" : ` #${s.lastRun.messageSeq}`}` : "";
      out.push(`- ${s.id} [${s.enabled ? "启用" : "已停"}] 会话 ${s.roomId}:${cronText(s.cron, s.tz)}${s.nextRunAt ? ` 下次 ${s.nextRunAt}` : ""}${last}${s.commitmentId ? ` · 承诺 ${s.commitmentId}` : ""}:${s.prompt}`);
    }
    for (const t of all<TriggerRow>(this.d.db, "SELECT * FROM gg_msg_triggers WHERE contact_id = ? ORDER BY created_at, id", contactId)) {
      if (!rooms.has(t.room_id)) continue;
      out.push(`- ${t.id} [${t.enabled ? "启用" : "已停"}] 会话 ${t.room_id}:每 ${t.every_n} 条消息(已计 ${t.counted} 条)${t.commitment_id ? ` · 承诺 ${t.commitment_id}` : ""}:${t.prompt}`);
    }
    return out;
  }
  /** 第 5 块指针:联系人自己在这些会话里的定时与触发器(含已停的);没有就不给 */
  pointers(contactId: string, roomIds: readonly string[]): { ref: string; text: string }[] {
    const l = this.lines(contactId, roomIds);
    return l.length ? [{ ref: "你的定时与常驻承诺", text: `\n${l.join("\n")}` }] : [];
  }
  /** schedule_list:联系人自己在这个会话的定时;不在这个会话返回 null。第一行写明用户设置的时区 */
  listText(contactId: string, roomId: string): string | null {
    if (!this.d.member(contactId, roomId)) return null;
    const l = this.lines(contactId, [roomId]);
    return [`用户设置的时区 ${this.d.timezone()}(schedule_set 不给 tz 时用它)`, ...(l.length ? l : ["(本会话没有你的定时)"])].join("\n");
  }
}
