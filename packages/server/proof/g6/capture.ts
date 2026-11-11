// G6 的录制层:包住进程内 fetch,把每次 Anthropic Messages 调用(含 SDK 自己的重试)记成一条 CallRecord;
// 按题集注入故障(不发上游、不花钱)。只记请求体与响应,不记请求头,密钥不进记录。
// 不改被测提交的代码:driver 在被测工作树里把 globalThis.fetch 换成它,宿主自己的装配(start.ts)照常建联系人脑子与压缩器。
import type { CallClass, CallOutcome, CallRecord, FaultKind, FixtureFault, Usage } from "./types.ts";

export interface ParsedRequest {
  readonly model: string | null;
  readonly maxTokens: number | null;
  readonly hasTools: boolean;
  readonly system: string;
  readonly request: string;
}
/** 工具结果的正文:字符串或文字块数组(不再往下嵌套) */
const plain = (c: unknown) => (typeof c === "string" ? c : Array.isArray(c) ? c.map((b) => (b as { text?: string }).text ?? "").join("\n") : "");
const textOf = (c: unknown) => {
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return "";
  return c
    .map((b) => {
      const x = b as { type?: string; text?: string; name?: string; input?: unknown; content?: unknown };
      if (x.type === "text") return x.text ?? "";
      if (x.type === "tool_use") return `[tool_use ${x.name ?? "?"}] ${JSON.stringify(x.input ?? null)}`;
      if (x.type === "tool_result") return plain(x.content);
      return "";
    })
    .join("\n");
};

export function parseRequest(body: string): ParsedRequest {
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(body) as Record<string, unknown>;
  } catch {
    return { model: null, maxTokens: null, hasTools: false, system: "", request: body };
  }
  const msgs = Array.isArray(j.messages) ? (j.messages as { role?: string; content?: unknown }[]) : [];
  return {
    model: typeof j.model === "string" ? j.model : null,
    maxTokens: typeof j.max_tokens === "number" ? j.max_tokens : null,
    hasTools: Array.isArray(j.tools) && j.tools.length > 0,
    system: textOf(j.system),
    request: msgs.map((m) => textOf(m.content)).join("\n"),
  };
}

const HEAD = /^#(\d+) · (\S+) · .*?\((user|contact|helper|system):[^)]*\)/;
export interface InboundLine {
  readonly roomId: string;
  readonly seq: number;
  readonly kind: string;
  readonly text: string;
}
/** 从第 4 块或检查材料里读出逐条消息(内核 renderInboundText 的呈现:头一行 `#seq · 会话 · 名字(种类:id) · 时间`,下面是原文)。 */
export function inboundLines(text: string): InboundLine[] {
  const out: { roomId: string; seq: number; kind: string; lines: string[] }[] = [];
  let cur: (typeof out)[number] | null = null;
  for (const line of text.split("\n")) {
    const h = HEAD.exec(line);
    if (h) {
      cur = { roomId: h[2]!, seq: Number(h[1]), kind: h[3]!, lines: [] };
      out.push(cur);
    } else if (/^\[[^\]]+\]|^<\/?block|^〔/.test(line)) cur = null;
    else if (cur) cur.lines.push(line);
  }
  return out.map((m) => ({ roomId: m.roomId, seq: m.seq, kind: m.kind, text: m.lines.join("\n").trim() }));
}

/** 取 `<block n="N">` 的正文(宿主五块的呈现);没有这块返回空串。 */
export const blockText = (request: string, n: number) => new RegExp(`<block n="${n}" label="[^"]*">\\n([\\s\\S]*?)\\n</block>`).exec(request)?.[1] ?? "";

/** 调用归类:带工具的是联系人一轮;不带工具的按说明文字分检查(要 memories JSON)/补写笔记/其余后台。 */
export function classifyCall(r: Pick<ParsedRequest, "hasTools" | "system">): CallClass {
  if (r.hasTools) return "round";
  if (r.system.includes('"memories"')) return "check";
  if (r.system.includes("状态笔记")) return "compact";
  return "background";
}

export interface ParsedReply {
  readonly stopReason: string | null;
  readonly usage: Usage;
  readonly text: string;
  readonly tools: { readonly name: string; readonly input: unknown }[];
  readonly error: string | null;
}
const ZERO: Usage = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

/** 解析 Anthropic Messages 的流式(SSE)或一次性 JSON 回复;解析不了的部分留空,不抛错。 */
export function parseReply(raw: string): ParsedReply {
  const usage = { ...ZERO };
  const blocks = new Map<number, { type: string; name: string; text: string; json: string }>();
  let stopReason: string | null = null;
  let error: string | null = null;
  const take = (u: Record<string, unknown> | undefined) => {
    if (!u) return;
    if (typeof u.input_tokens === "number") usage.input = u.input_tokens;
    if (typeof u.output_tokens === "number") usage.output = u.output_tokens;
    if (typeof u.cache_read_input_tokens === "number") usage.cacheRead = u.cache_read_input_tokens;
    if (typeof u.cache_creation_input_tokens === "number") usage.cacheWrite = u.cache_creation_input_tokens;
  };
  const trimmed = raw.trimStart();
  if (trimmed.startsWith("{")) {
    try {
      const m = JSON.parse(trimmed) as { type?: string; content?: unknown; stop_reason?: string; usage?: Record<string, unknown>; error?: { message?: string } };
      if (m.type === "error") error = m.error?.message ?? "error";
      take(m.usage);
      stopReason = m.stop_reason ?? null;
      const content = Array.isArray(m.content) ? (m.content as { type?: string; text?: string; name?: string; input?: unknown }[]) : [];
      return {
        stopReason,
        usage,
        error,
        text: content.filter((c) => c.type === "text").map((c) => c.text ?? "").join(""),
        tools: content.filter((c) => c.type === "tool_use").map((c) => ({ name: c.name ?? "?", input: c.input ?? null })),
      };
    } catch {
      return { stopReason, usage, error: "回复不是合法 JSON", text: "", tools: [] };
    }
  }
  for (const line of raw.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    let e: Record<string, unknown>;
    try {
      e = JSON.parse(line.slice(5).trim()) as Record<string, unknown>;
    } catch {
      continue;
    }
    const idx = typeof e.index === "number" ? e.index : -1;
    if (e.type === "message_start") take((e.message as { usage?: Record<string, unknown> } | undefined)?.usage);
    else if (e.type === "content_block_start") {
      const b = e.content_block as { type?: string; name?: string; text?: string };
      blocks.set(idx, { type: b?.type ?? "?", name: b?.name ?? "", text: b?.text ?? "", json: "" });
    } else if (e.type === "content_block_delta") {
      const b = blocks.get(idx);
      const d = e.delta as { type?: string; text?: string; partial_json?: string };
      if (b && d?.type === "text_delta") b.text += d.text ?? "";
      if (b && d?.type === "input_json_delta") b.json += d.partial_json ?? "";
    } else if (e.type === "message_delta") {
      const d = e.delta as { stop_reason?: string } | undefined;
      if (d?.stop_reason) stopReason = d.stop_reason;
      take(e.usage as Record<string, unknown> | undefined);
    } else if (e.type === "error") error = (e.error as { message?: string } | undefined)?.message ?? "error";
  }
  const ordered = [...blocks.entries()].sort((a, b) => a[0] - b[0]).map(([, b]) => b);
  return {
    stopReason,
    usage,
    error,
    text: ordered.filter((b) => b.type === "text").map((b) => b.text).join(""),
    tools: ordered
      .filter((b) => b.type === "tool_use")
      .map((b) => {
        let input: unknown = null;
        try {
          input = b.json.trim() === "" ? {} : JSON.parse(b.json);
        } catch {
          input = b.json;
        }
        return { name: b.name, input };
      }),
  };
}

/** 检查调用的输出能不能当成一次完整检查:必须是带 memories 数组的 JSON 对象。 */
export function checkOutputParses(text: string): boolean {
  const a = text.indexOf("{");
  const b = text.lastIndexOf("}");
  if (a < 0 || b < a) return false;
  try {
    const v = JSON.parse(text.slice(a, b + 1)) as unknown;
    return typeof v === "object" && v !== null && !Array.isArray(v) && Array.isArray((v as { memories?: unknown }).memories);
  } catch {
    return false;
  }
}

/** runner 自己对一次调用结果的判定(不信被测宿主的自报)。 */
export function judgeCall(cls: CallClass, status: number, r: ParsedReply): CallOutcome {
  if (status === 408 || status === 504) return "timeout";
  if (status !== 200 || r.error !== null) return "http_error";
  if (r.stopReason === "max_tokens") return "truncated";
  if (cls === "check") {
    if (r.text.trim() === "") return "empty";
    return checkOutputParses(r.text) ? "ok" : "parse_failure";
  }
  if (r.text.trim() === "" && r.tools.length === 0) return "empty";
  return "ok";
}

/** 组一份 Anthropic SSE 回复(规则替身与故障注入共用)。 */
export function sseMessage(o: { model: string; blocks: readonly ({ type: "text"; text: string } | { type: "tool_use"; name: string; input: unknown })[]; stopReason: string; usage: Usage }) {
  const ev = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  let s = ev("message_start", {
    type: "message_start",
    message: { id: "msg_g6", type: "message", role: "assistant", model: o.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: o.usage.input, output_tokens: 0, cache_read_input_tokens: o.usage.cacheRead, cache_creation_input_tokens: o.usage.cacheWrite } },
  });
  o.blocks.forEach((b, i) => {
    if (b.type === "text") {
      s += ev("content_block_start", { type: "content_block_start", index: i, content_block: { type: "text", text: "" } });
      s += ev("content_block_delta", { type: "content_block_delta", index: i, delta: { type: "text_delta", text: b.text } });
    } else {
      s += ev("content_block_start", { type: "content_block_start", index: i, content_block: { type: "tool_use", id: `toolu_g6_${i}`, name: b.name, input: {} } });
      s += ev("content_block_delta", { type: "content_block_delta", index: i, delta: { type: "input_json_delta", partial_json: JSON.stringify(b.input) } });
    }
    s += ev("content_block_stop", { type: "content_block_stop", index: i });
  });
  s += ev("message_delta", { type: "message_delta", delta: { stop_reason: o.stopReason, stop_sequence: null }, usage: { output_tokens: o.usage.output } });
  s += ev("message_stop", { type: "message_stop" });
  return s;
}
export const sseResponse = (body: string, status = 200): Response => new Response(body, { status, headers: { "content-type": "text/event-stream", "request-id": "g6-local" } });

/** 注入的故障回复。network 不给回复,直接按传输失败抛错。截断的文字按调用类区分(检查是半个 JSON,补写是半份笔记)。 */
export function faultResponse(kind: FaultKind, model: string, cls: CallClass): Response {
  const err = (status: number) => new Response(JSON.stringify({ type: "error", error: { type: status === 529 ? "overloaded_error" : "invalid_request_error", message: `g6 注入的故障(${kind})` } }), { status, headers: { "content-type": "application/json", "x-should-retry": "false", "request-id": "g6-fault" } });
  if (kind === "http-400") return err(400);
  if (kind === "http-529") return err(529);
  if (kind === "network") throw new TypeError(`fetch failed(g6 注入的故障 network)`);
  if (kind === "truncated") return sseResponse(sseMessage({ model, blocks: [{ type: "text", text: cls === "check" ? '{"note": "截断的检查输出,后半没写完' : "截断的半份笔记:用户要求先" }], stopReason: "max_tokens", usage: ZERO }));
  if (kind === "malformed") return sseResponse(sseMessage({ model, blocks: [{ type: "text", text: "好的,我检查过了,这一轮没有问题。" }], stopReason: "end_turn", usage: ZERO }));
  return sseResponse(sseMessage({ model, blocks: [], stopReason: "end_turn", usage: ZERO }));
}

export interface Recorder {
  readonly fetch: typeof globalThis.fetch;
  /** 等所有在途调用的响应读完并落进记录。 */
  flush(): Promise<void>;
  readonly calls: CallRecord[];
}

/**
 * 录制并按需注入故障的 fetch。只处理 /v1/messages,其余原样转发。
 * contactOf 用请求文字把调用归到题集里的联系人(人设 marker);timeoutMs 是 runner 给单次调用的上限,到点按 timeout 记。
 */
export function recordingFetch(o: { upstream: typeof globalThis.fetch; contactOf: (text: string) => string | null; faults: readonly FixtureFault[]; timeoutMs?: number; now?: () => number }): Recorder {
  const now = o.now ?? Date.now;
  const calls: CallRecord[] = [];
  const pending = new Set<Promise<void>>();
  const counts = new Map<string, number>();
  let n = 0;
  const fetchFn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!/\/v1\/messages(?:\?|$)/.test(url)) return o.upstream(input, init);
    const body = typeof init?.body === "string" ? init.body : "";
    const req = parseRequest(body);
    const cls = classifyCall(req);
    const contact = o.contactOf(`${req.system}\n${req.request}`);
    const key = `${contact ?? "?"}|${cls}`;
    const nth = (counts.get(key) ?? 0) + 1;
    counts.set(key, nth);
    const fault = o.faults.find((f) => f.contact === contact && f.cls === cls && f.nth === nth)?.fault ?? null;
    const no = ++n;
    const at = now();
    const base = { n: no, at, contact, cls, model: req.model, maxTokens: req.maxTokens, system: req.system, request: req.request, fault };
    const push = (status: number, r: ParsedReply, outcome: CallOutcome) => {
      calls.push({ ...base, ms: now() - at, status, outcome, stopReason: r.stopReason, usage: r.usage, tools: r.tools, text: r.text });
    };
    const empty: ParsedReply = { stopReason: null, usage: ZERO, text: "", tools: [], error: null };
    let res: Response;
    // runner 给单次调用的上限(含读完流式正文);计时器是普通的(不 unref),到点中止并按 timeout 记
    const ctl = o.timeoutMs ? new AbortController() : null;
    let timedOut = false;
    const timer = ctl
      ? setTimeout(() => {
          timedOut = true;
          ctl.abort(new Error("g6 单次调用超时"));
        }, o.timeoutMs)
      : null;
    const stop = () => {
      if (timer) clearTimeout(timer);
    };
    try {
      if (fault) res = faultResponse(fault, req.model ?? "?", cls);
      else {
        const signals = [init?.signal, ctl?.signal].filter((s): s is AbortSignal => s instanceof AbortSignal);
        res = await o.upstream(input, { ...init, ...(signals.length ? { signal: AbortSignal.any(signals) } : {}) });
      }
    } catch (e) {
      stop();
      push(0, empty, timedOut ? "timeout" : "network_error");
      throw e;
    }
    const copy = res.clone();
    const done = copy
      .text()
      .then(
        (t) => {
          const r = parseReply(t);
          push(res.status, r, judgeCall(cls, res.status, r));
        },
        () => push(res.status, empty, timedOut ? "timeout" : "network_error"),
      )
      .finally(() => {
        stop();
        pending.delete(done);
      });
    pending.add(done);
    return res;
  };
  return {
    fetch: fetchFn as typeof globalThis.fetch,
    calls,
    async flush() {
      while (pending.size) await Promise.all([...pending]);
    },
  };
}
