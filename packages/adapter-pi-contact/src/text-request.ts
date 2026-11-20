import { normalizeContext, type SystemMessage, type UserMessage } from "@earendil-works/pi-ai";
import type { UsageSink } from "@g-group/kernel";
import { PiContactMindError } from "./errors.ts";
import type { PiContactMindOptions } from "./mind.ts";
import { describe, resolveOptions, streamRequest, withProtocols, type Resolved } from "./request.ts";

interface TextRequest {
  readonly system: string;
  readonly prompt: string;
  readonly signal: AbortSignal;
  readonly failureLabel: string;
  readonly empty: string;
  readonly sessionId?: string;
  readonly usage?: UsageSink;
}

/** A single, tool-free model response through the existing protocol selection and usage path. */
export async function textRequest(cfg: Resolved, input: TextRequest): Promise<string> {
  const timestamp = Date.now();
  const system: SystemMessage = { role: "system", content: input.system, timestamp };
  const user: UserMessage = { role: "user", content: [{ type: "text", text: input.prompt }], timestamp };
  const context = normalizeContext({ messages: [system, user] });
  return (await withProtocols(cfg, input.signal, async (attempt) => {
    const fail = (why: string) => new PiContactMindError("provider-error", cfg.redact(`${input.failureLabel}:${why}`));
    let msg;
    try {
      msg = await streamRequest(cfg, attempt, context, {
        options: { signal: input.signal }, cache: false, request: 1,
        sessionId: input.sessionId,
        ...(input.usage ? { sink: input.usage } : {}),
      }).result();
    } catch (e) { throw fail(describe(e)); }
    if (msg.stopReason === "error" || msg.stopReason === "aborted") throw fail(`(${msg.stopReason}):${msg.errorMessage ?? "无错误信息"}`);
    if (msg.stopReason === "length") throw fail("输出因长度上限截断(length)");
    const text = msg.content.map((c) => c.type === "text" ? c.text : "").join("").trim();
    if (!text) throw fail(input.empty);
    return text;
  })).value;
}

export function createPiTextResponder(opts: PiContactMindOptions) {
  const cfg = resolveOptions(opts, "helper");
  return (system: string, prompt: string, signal: AbortSignal) =>
    textRequest(cfg, { system, prompt, signal, failureLabel: "Helper 请求失败", empty: "模型返回了空回复" });
}
