// 上下文装配(AC-06):窗口 + 被引用 #seq 的确定性 Page-in;超预算显式失败,禁止静默截断。
import { type Log, type ProjectedMessage, project } from "@g-group/domain";

export interface AssembleOptions {
  /** 最近多少条可见消息进窗口(撤回的不算) */
  readonly window: number;
  /** 被引用的 #seq,原文必须精确进装配 */
  readonly quotes: readonly number[];
  /** 装配内容的字节上限(UTF-8) */
  readonly budgetBytes: number;
}
export interface ManifestEntry { readonly seq: number; readonly bytes: number; readonly via: "window" | "page-in" }
export type AssembleResult =
  | { ok: true; manifest: ManifestEntry[]; content: string; totalBytes: number; skipped: { seq: number; reason: "retracted" }[] }
  | { ok: false; reason: "over-budget"; need: number; budget: number }
  | { ok: false; reason: "quote-not-found"; seq: number };

const render = (m: ProjectedMessage) => `#${m.seq} ${m.sender.kind}:${m.sender.id}: ${m.text}\n`;

/** 被引用消息按 seq 精确查找,与它离现在多远无关。 */
function lookup(all: readonly ProjectedMessage[], seq: number): ProjectedMessage | undefined {
  return all.find((m) => m.seq === seq);
}

export function assemble(log: Log, opts: AssembleOptions): AssembleResult {
  const all = project(log);
  const visible = all.filter((m) => !m.retracted);
  const windowed = opts.window > 0 ? visible.slice(-opts.window) : [];
  const inWindow = new Set(windowed.map((m) => m.seq));

  const paged: ProjectedMessage[] = [];
  const skipped: { seq: number; reason: "retracted" }[] = [];
  for (const seq of opts.quotes) {
    const m = lookup(all, seq);
    if (!m) return { ok: false, reason: "quote-not-found", seq };
    if (m.retracted) { skipped.push({ seq, reason: "retracted" }); continue; }
    if (inWindow.has(seq) || paged.some((p) => p.seq === seq)) continue;
    paged.push(m);
  }

  const parts = [...paged.map((m) => ({ m, via: "page-in" as const })), ...windowed.map((m) => ({ m, via: "window" as const }))];
  const chunks = parts.map(({ m, via }) => { const text = render(m); return { text, entry: { seq: m.seq, bytes: Buffer.byteLength(text, "utf8"), via } }; });
  const need = chunks.reduce((a, c) => a + c.entry.bytes, 0);
  if (need > opts.budgetBytes) return { ok: false, reason: "over-budget", need, budget: opts.budgetBytes };
  return { ok: true, manifest: chunks.map((c) => c.entry), content: chunks.map((c) => c.text).join(""), totalBytes: need, skipped };
}
