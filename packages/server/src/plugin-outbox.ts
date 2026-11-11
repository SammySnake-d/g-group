// 插件外发的权威状态(T-177 C)——红提交空壳:签名在,返回假值,还没有表。
import type { ChannelIdempotency, SendResult } from "@g-group/kernel";
import type { Db } from "./db.ts";

export type OutboxState = "in_flight" | "confirmed" | "delivery_unknown";
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
export interface OutboxInstall {
  readonly installId: string;
  readonly version: string;
}
export interface OutboxPrint {
  readonly sha256: string;
  readonly bytes: number;
}
export interface OutboxChannel {
  readonly endpoint: string;
  readonly idempotency: ChannelIdempotency;
  readonly windowMs: number | null;
}
export interface OutboxClaim {
  readonly pluginId: string;
  readonly actionId: string;
  readonly token: string;
  readonly fresh: boolean;
  readonly priorReason: string | null;
}
export type OutboxResult = SendResult | { ok: false; state: "delivery-unknown"; reason: "host-restarted"; detail: string };

export function printOf(_payload: string): OutboxPrint {
  return { sha256: "", bytes: 0 };
}

export class PluginOutbox {
  readonly boot: string;
  constructor(_db: Db, _now: () => string, boot = "") {
    this.boot = boot;
  }
  view(_pluginId: string, _actionId: string): OutboxView | undefined {
    return undefined;
  }
  durability(): { journalMode: string; synchronous: number } {
    return { journalMode: "", synchronous: -1 };
  }
  decide(_pluginId: string, _actionId: string, _print: OutboxPrint, _install: OutboxInstall, _ch: OutboxChannel | null): SendResult | null {
    return null;
  }
  claim(_pluginId: string, _actionId: string, _print: OutboxPrint, _install: OutboxInstall, _ch: OutboxChannel): OutboxClaim | null {
    return null;
  }
  release(_c: OutboxClaim) {}
  settle(_c: OutboxClaim, r: SendResult): OutboxResult {
    return r;
  }
}
