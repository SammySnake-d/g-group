// 插件外发的权威状态(T-177 C,审查记录 t177-backend-resume-review.md §C 十一条):宿主 SQLite 一张表,跨宿主重启保留。
// 内核注册表(kernel/plugins.ts)照旧当进程内执行器:B1 窗口、单调时钟、渠道版本都还由它判;这里只管「宿主重启、卸载重装之后还记得」。
//   - 唯一键 (plugin_id, action_id),不含安装身份:卸载重装后同一个动作仍对到同一行,已确认复用回执、结果未知不再发;
//   - 绑定列:install_id、包版本、endpoint、idempotency、window_ms、payload_sha256 与字节数;不存载荷原文,回执 id 原样存;
//   - 写前日志:in_flight 行提交成功才交给插件;写不进就不发;
//   - 并发:INSERT … ON CONFLICT DO NOTHING / 条件 UPDATE,改到行的那一个才有外发权;
//   - 启动:别的启动留下的 in_flight 一律改成 delivery_unknown(host-restarted);之后结果未知的动作 B2 按合同、B1 因单调时钟不跨进程,都不自动重发;
//   - 迟到结果:只在行仍是本次认领的 in_flight 时落地,已被改成未知的不改写。
// 持久化级别:WAL,synchronous 用库默认(durability() 读回),只承诺宿主进程崩溃这一边界,不声称覆盖断电或系统崩溃。
import { createHash, randomUUID } from "node:crypto";
import type { ChannelIdempotency, SendResult } from "@g-group/kernel";
import { type Db, one, run } from "./db.ts";

const SCHEMA = `CREATE TABLE IF NOT EXISTS gg_plugin_outbox (
  plugin_id TEXT NOT NULL, action_id TEXT NOT NULL,
  install_id TEXT NOT NULL, version TEXT NOT NULL, endpoint TEXT NOT NULL, idempotency TEXT NOT NULL, window_ms INTEGER,
  payload_sha256 TEXT NOT NULL, payload_bytes INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('in_flight', 'confirmed', 'delivery_unknown')), reason TEXT, receipt_id TEXT,
  boot TEXT NOT NULL, attempt TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY (plugin_id, action_id)
)`;

export type OutboxState = "in_flight" | "confirmed" | "delivery_unknown";
/** 一个外发动作的落盘记录(给对账与测试看;没有载荷原文)。 */
export interface OutboxView {
  readonly pluginId: string;
  readonly actionId: string;
  readonly state: OutboxState;
  readonly reason: string | null;
  readonly receiptId: string | null;
  readonly installId: string;
  readonly version: string;
  readonly endpoint: string;
  readonly idempotency: ChannelIdempotency;
  readonly windowMs: number | null;
  readonly payloadSha256: string;
  readonly payloadBytes: number;
  readonly boot: string;
}
/** 调用方这一次的安装身份与载荷指纹。 */
export interface OutboxInstall {
  readonly installId: string;
  readonly version: string;
}
export interface OutboxPrint {
  readonly sha256: string;
  readonly bytes: number;
}
/** 进程就绪后插件自述的渠道。 */
export interface OutboxChannel {
  readonly endpoint: string;
  readonly idempotency: ChannelIdempotency;
  readonly windowMs: number | null;
}
/** 认领凭据:只有拿着它的那一次调用能把结果写回这一行。 */
export interface OutboxClaim {
  readonly pluginId: string;
  readonly actionId: string;
  readonly token: string;
  /** 新插入的行;否则是同一次启动里把结果未知的 B1 动作重新认领 */
  readonly fresh: boolean;
  readonly priorReason: string | null;
}
/** 宿主层的外发结果:内核的三态之外,多一种「宿主重启后这一行已记为未知,迟到的结果不改写」。 */
export type OutboxResult = SendResult | { ok: false; state: "delivery-unknown"; reason: "host-restarted"; detail: string };
/** 一条迟到应答的记录(红提交空壳)。 */
export interface LateReceiptView {
  readonly pluginId: string;
  readonly actionId: string;
  readonly attempt: string;
  readonly cause: string;
  readonly stateAtArrival: OutboxState | null;
  readonly reasonAtArrival: string | null;
  readonly installId: string | null;
  readonly version: string | null;
  readonly endpoint: string | null;
  readonly boot: string;
  readonly receivedAt: string;
  readonly receiptId: string | null;
  readonly actionMatches: boolean;
  readonly replySha256: string;
  readonly replyBytes: number;
}

interface Row {
  plugin_id: string;
  action_id: string;
  install_id: string;
  version: string;
  endpoint: string;
  idempotency: string;
  window_ms: number | null;
  payload_sha256: string;
  payload_bytes: number;
  state: OutboxState;
  reason: string | null;
  receipt_id: string | null;
  boot: string;
  attempt: string;
}

/** 载荷 UTF-8 字节的 sha256 与字节数(与内核账本同一算法)。 */
export function printOf(payload: string): OutboxPrint {
  const buf = Buffer.from(payload, "utf8");
  return { sha256: createHash("sha256").update(buf).digest("hex"), bytes: buf.byteLength };
}

const MANUAL = "需人工对账";

export class PluginOutbox {
  private readonly db: Db;
  private readonly now: () => string;
  /** 本次启动的编号:每个 PluginStore 一个;别的编号留下的在途行在启动时改成结果未知 */
  readonly boot: string;

  constructor(db: Db, now: () => string, boot: string = randomUUID()) {
    this.db = db;
    this.now = now;
    this.boot = boot;
    db.store.db.exec(SCHEMA);
    // 上一次(或别的)启动交给插件、还没落结果的动作:宿主不知道对方收没收到,一律记结果未知
    run(db, "UPDATE gg_plugin_outbox SET state = 'delivery_unknown', reason = 'host-restarted', updated_at = ? WHERE state = 'in_flight' AND boot <> ?", now(), boot);
  }

  private row(pluginId: string, actionId: string): Row | undefined {
    return one<Row>(this.db, "SELECT * FROM gg_plugin_outbox WHERE plugin_id = ? AND action_id = ?", pluginId, actionId);
  }

  view(pluginId: string, actionId: string): OutboxView | undefined {
    const r = this.row(pluginId, actionId);
    if (!r) return undefined;
    return {
      pluginId: r.plugin_id,
      actionId: r.action_id,
      state: r.state,
      reason: r.reason,
      receiptId: r.receipt_id,
      installId: r.install_id,
      version: r.version,
      endpoint: r.endpoint,
      idempotency: r.idempotency as ChannelIdempotency,
      windowMs: r.window_ms,
      payloadSha256: r.payload_sha256,
      payloadBytes: r.payload_bytes,
      boot: r.boot,
    };
  }

  /** 持久化级别读回(收据记录用)。 */
  durability(): { journalMode: string; synchronous: number } {
    const j = one<{ journal_mode: string }>(this.db, "PRAGMA journal_mode");
    const s = one<{ synchronous: number }>(this.db, "PRAGMA synchronous");
    return { journalMode: String(j?.journal_mode ?? ""), synchronous: Number(s?.synchronous ?? -1) };
  }

  /**
   * 已有记录时这一次怎么办:返回结果就不发;返回 null 就可以去认领(没有记录,或同一次启动里结果未知的 B1 交给内核按窗口判)。
   * ch 为 null 时是进程还没起的预判,只做不需要渠道自述的判断。
   */
  decide(pluginId: string, actionId: string, print: OutboxPrint, install: OutboxInstall, ch: OutboxChannel | null): SendResult | null {
    const r = this.row(pluginId, actionId);
    if (!r) return null;
    if (r.payload_sha256 !== print.sha256) return { ok: false, state: "rejected", reason: "payload-mismatch", detail: "同一 action_id 的内容必须逐字节一致" };
    if (r.state === "confirmed") return { ok: true, state: "confirmed", receipt: { action_id: actionId, receiptId: r.receipt_id ?? "" }, deduplicated: true };
    if (r.state === "in_flight") return { ok: false, state: "rejected", reason: "in-flight", detail: "上一次发送还没有结果" };
    const why = r.reason ? `(上次:${r.reason})` : "";
    if (r.idempotency === "none") return { ok: false, state: "delivery-unknown", reason: "retry-refused", detail: `B2 渠道结果未知${why},禁止自动重发,${MANUAL}` };
    if (r.install_id !== install.installId || r.version !== install.version)
      return { ok: false, state: "delivery-unknown", reason: "channel-changed", detail: `首次投递在安装 ${r.install_id} 版本 ${r.version},现在是安装 ${install.installId} 版本 ${install.version};新安装不知道旧投递,${MANUAL}` };
    if (r.boot !== this.boot) return { ok: false, state: "delivery-unknown", reason: "clock-untrusted", detail: `宿主重启过${why}:单调时钟不跨进程,无法确认离首次尝试过了多久,不自动重发,${MANUAL}` };
    if (ch && (ch.endpoint !== r.endpoint || ch.idempotency !== r.idempotency || ch.windowMs !== r.window_ms))
      return { ok: false, state: "delivery-unknown", reason: "channel-changed", detail: `首次投递的接收端是 ${r.endpoint},现在是 ${ch.endpoint};${MANUAL}` };
    return null;
  }

  /** 认领外发权:先 INSERT … ON CONFLICT DO NOTHING,插入成功的才有外发权;已有行时只能把同一次启动里结果未知的行条件改回在途。
   *  写不进数据库就抛错(调用方不发);别人先认领了返回 null。 */
  claim(pluginId: string, actionId: string, print: OutboxPrint, install: OutboxInstall, ch: OutboxChannel): OutboxClaim | null {
    const token = randomUUID();
    const at = this.now();
    const inserted = run(
      this.db,
      `INSERT INTO gg_plugin_outbox (plugin_id, action_id, install_id, version, endpoint, idempotency, window_ms, payload_sha256, payload_bytes, state, reason, receipt_id, boot, attempt, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'in_flight', NULL, NULL, ?, ?, ?, ?) ON CONFLICT (plugin_id, action_id) DO NOTHING`,
      pluginId,
      actionId,
      install.installId,
      install.version,
      ch.endpoint,
      ch.idempotency,
      ch.windowMs,
      print.sha256,
      print.bytes,
      this.boot,
      token,
      at,
      at,
    );
    if (inserted === 1) return { pluginId, actionId, token, fresh: true, priorReason: null };
    const prior = this.row(pluginId, actionId);
    if (prior?.state !== "delivery_unknown" || prior.boot !== this.boot || prior.payload_sha256 !== print.sha256) return null;
    const n = run(
      this.db,
      "UPDATE gg_plugin_outbox SET state = 'in_flight', attempt = ?, updated_at = ? WHERE plugin_id = ? AND action_id = ? AND state = 'delivery_unknown' AND attempt = ?",
      token,
      at,
      pluginId,
      actionId,
      prior.attempt,
    );
    return n === 1 ? { pluginId, actionId, token, fresh: false, priorReason: prior.reason } : null;
  }

  /** 认领之后没发生投递(内核拒收、调用出错):新行删掉,重新认领的行退回结果未知。 */
  release(c: OutboxClaim) {
    if (c.fresh) run(this.db, "DELETE FROM gg_plugin_outbox WHERE plugin_id = ? AND action_id = ? AND state = 'in_flight' AND attempt = ?", c.pluginId, c.actionId, c.token);
    else
      run(
        this.db,
        "UPDATE gg_plugin_outbox SET state = 'delivery_unknown', reason = ?, updated_at = ? WHERE plugin_id = ? AND action_id = ? AND state = 'in_flight' AND attempt = ?",
        c.priorReason,
        this.now(),
        c.pluginId,
        c.actionId,
        c.token,
      );
  }

  /** 记一条迟到应答(红提交空壳:不记)。 */
  recordLate(_c: OutboxClaim, _cause: string, _reply: unknown) {}

  /** 一个动作的全部迟到应答(红提交空壳)。 */
  lateReceipts(_pluginId: string, _actionId: string): LateReceiptView[] {
    return [];
  }

  /** 把内核这一次的结果落到认领的行上;行已被别的启动改成结果未知时不改写,按表里的状态返回。 */
  settle(c: OutboxClaim, r: SendResult): OutboxResult {
    let n: number;
    if (r.ok) {
      n = run(
        this.db,
        "UPDATE gg_plugin_outbox SET state = 'confirmed', reason = NULL, receipt_id = ?, updated_at = ? WHERE plugin_id = ? AND action_id = ? AND state = 'in_flight' AND attempt = ?",
        r.receipt.receiptId,
        this.now(),
        c.pluginId,
        c.actionId,
        c.token,
      );
    } else if (r.state === "delivery-unknown") {
      n = run(
        this.db,
        "UPDATE gg_plugin_outbox SET state = 'delivery_unknown', reason = ?, updated_at = ? WHERE plugin_id = ? AND action_id = ? AND state = 'in_flight' AND attempt = ?",
        r.reason,
        this.now(),
        c.pluginId,
        c.actionId,
        c.token,
      );
    } else {
      this.release(c);
      return r;
    }
    if (n === 1) return r;
    const cur = this.row(c.pluginId, c.actionId);
    return { ok: false, state: "delivery-unknown", reason: "host-restarted", detail: `这一行已记为${cur?.state === "delivery_unknown" ? `结果未知(${cur.reason ?? ""})` : "别的结果"},迟到的结果不改写,${MANUAL}` };
  }
}
