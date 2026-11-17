// 事件总线:给每条事件分配递增 eventSeq,保留最近 capacity 条供续订补发;续订点早于保留窗口时发 stream.resync。
import type { ServerEvent } from "@g-group/api-contract";

type Payload = ServerEvent extends infer E ? (E extends { type: infer T; eventSeq: number; at: string } ? Omit<E, "eventSeq" | "at"> & { type: T } : never) : never;
export type EventDraft = Payload;

export interface Bus {
  emit(draft: EventDraft): ServerEvent;
  subscribe(listener: (e: ServerEvent) => void, sinceEventSeq?: number): () => void;
  head(): number;
}

export function createBus(now: () => string, capacity = 2000): Bus {
  let seq = 0;
  const ring: ServerEvent[] = [];
  const listeners = new Set<(e: ServerEvent) => void>();
  const deliver = (l: (e: ServerEvent) => void, e: ServerEvent) => {
    try {
      l(e);
    } catch {
      /* 一个订阅者出错不影响其他订阅者 */
    }
  };
  return {
    emit(draft) {
      const e = { ...draft, eventSeq: ++seq, at: now() } as ServerEvent;
      ring.push(e);
      if (ring.length > capacity) ring.shift();
      for (const l of listeners) deliver(l, e);
      return e;
    },
    subscribe(listener, since) {
      if (since !== undefined && since < seq) {
        const oldest = ring[0]?.eventSeq ?? seq + 1;
        if (since + 1 < oldest) deliver(listener, { type: "stream.resync", eventSeq: seq, at: now(), reason: `续订点 ${since} 早于保留窗口 ${oldest}` } as ServerEvent);
        else for (const e of ring) if (e.eventSeq > since) deliver(listener, e);
      }
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    head: () => seq,
  };
}
