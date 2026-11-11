// 外部数据源进会话(US12①④、US4/US5、U19、需求 D04.1;AC-35 阶段 I 外部源入库与读取)。空壳:签名在,行为未实现。
import type { PluginAttachmentView } from "@g-group/api-contract";
import type { ExternalReadQuery, ExternalReadResult, TimerApi } from "@g-group/kernel";
import { type Db, HostError } from "./db.ts";
import type { PluginStore } from "./plugins.ts";

export interface PluginSourcesDeps {
  readonly db: Db;
  readonly plugins: PluginStore;
  readonly clockMs: () => number;
  readonly timers: TimerApi;
  readonly newId: (prefix: string) => string;
  readonly userInRoom: (roomId: string) => boolean;
  readonly report?: (what: string, detail: unknown) => void;
  readonly readBudgetBytes?: number;
}
export interface AttachInput {
  readonly clientActionId: string;
  readonly pluginId: string;
  readonly roomId: string;
  readonly sourceId?: string;
  readonly config?: { readonly intervalSec?: number };
}

export class PluginSources {
  readonly deps: PluginSourcesDeps;
  constructor(d: PluginSourcesDeps) {
    this.deps = d;
  }
  attach(_p: AttachInput): PluginAttachmentView {
    throw new HostError("unavailable", "未实现");
  }
  detach(_p: { pluginId: string; roomId: string; sourceId?: string }) {
    return false;
  }
  list(_q: { roomId?: string; pluginId?: string }): PluginAttachmentView[] {
    return [];
  }
  async pull(_pluginId: string, _roomId: string, _sourceId?: string) {
    return { events: [], rejected: [], failures: [], attachments: [] as PluginAttachmentView[] };
  }
  read(_scope: { contactId: string; roomIds: readonly string[] }, _q: ExternalReadQuery): ExternalReadResult {
    return { ok: false, why: "未实现" };
  }
  hints(_roomIds: readonly string[]): { ref: string; text: string }[] {
    return [];
  }
  tick() {}
  stop() {}
  async idle() {}
}
