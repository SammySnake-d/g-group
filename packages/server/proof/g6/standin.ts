// G6 规则替身:进程内的 Anthropic Messages 兼容端点,不连模型、不花钱,用来把 runner 自己测透。
// 它是「理想读者」:追问时只要宿主把 needs 原文放进了请求就答对,没放就答看不到——所以替身组的读回率测的是宿主装配,
// 不是模型能力。替身结果在报告里单独标「规则替身」,不当模型效果。
import { blockText as block, inboundLines, parseRequest, sseMessage, sseResponse } from "./capture.ts";
import type { FixtureItem, FixtureProbe, Usage } from "./types.ts";

const LONG = /以后|所有|一律|始终|每次/;
const NOT_STATED = /[?？]\s*$|假如|如果|要不要|会怎样|会怎么样/;
const REMEMBER = /以后|所有|一律|始终|每次|记住/;
const est = (s: string) => Math.ceil(Buffer.byteLength(s, "utf8") / 3);
const UNSEEN = "我这边看不到之前的内容,能再说一下吗?";

/** 追问的回答:needs 为 null 或已出现在请求里(第 4 块之外)就给题集答案,否则说看不到。 */
export function probeAnswer(p: FixtureProbe, context: string): string {
  return p.needs === null || context.includes(p.needs) ? p.standin.answer : UNSEEN;
}

/** 替身一次回复的决定(纯函数,便于单测):返回 SSE 正文。 */
export function standinReply(item: FixtureItem, body: string) {
  const req = parseRequest(body);
  const model = req.model ?? "standin";
  const usage = (out: string): Usage => ({ input: est(`${req.system}\n${req.request}`), output: est(out), cacheRead: 0, cacheWrite: 0 });
  if (req.hasTools) {
    // 同一轮工具往返之后:收尾,不再调工具
    if (/"type"\s*:\s*"tool_result"/.test(body)) return sseMessage({ model, blocks: [{ type: "text", text: "好的。" }], stopReason: "end_turn", usage: usage("好的。") });
    const fresh = inboundLines(block(req.request, 4)).filter((l) => l.kind === "user");
    const context = `${req.system}\n${req.request.replace(block(req.request, 4), "")}`;
    const blocks: ({ type: "text"; text: string } | { type: "tool_use"; name: string; input: unknown })[] = [];
    const rooms = [...new Set(fresh.map((l) => l.roomId))];
    for (const roomId of rooms) {
      const last = fresh.filter((l) => l.roomId === roomId).at(-1)!;
      const probe = item.probes.find((p) => {
        const s = item.steps[p.step];
        return s?.op === "send" && s.text === last.text;
      });
      let text = `收到:${last.text.slice(0, 20)}`;
      let plain = false;
      if (probe) {
        text = probeAnswer(probe, context);
        plain = probe.standin.plainText === true;
      }
      blocks.push(plain ? { type: "text", text } : { type: "tool_use", name: "reply", input: { roomId, text, replyToSeq: last.seq } });
    }
    // 有损笔记:只留最近两条用户原文,早先的细节会掉出去
    const kept = [...block(req.request, 3).split("\n").filter((l) => l.startsWith("- ")), ...fresh.map((l) => `- ${l.text}`)].slice(-2);
    if (kept.length && item.standin?.noNote !== true) blocks.push({ type: "tool_use", name: "update_state_note", input: { note: kept.join("\n") } });
    const out = JSON.stringify(blocks);
    return sseMessage({ model, blocks, stopReason: blocks.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn", usage: usage(out) });
  }
  if (req.system.includes('"memories"')) {
    const lines = inboundLines(req.request).filter((l) => l.kind === "user");
    const memories = lines
      .filter((l) => REMEMBER.test(l.text) && !NOT_STATED.test(l.text))
      .map((l) => ({ title: l.text.slice(0, 16), text: l.text, anchors: LONG.test(l.text) ? ["global"] : [`room:${l.roomId}`], relation: null, target: null, roomId: l.roomId, sourceSeq: l.seq, evidence: l.text, kind: "preference" }));
    const noteWritten = req.request.includes("模型已写笔记");
    const json = JSON.stringify({ note: noteWritten ? null : lines.map((l) => `- ${l.text}`).join("\n") || "- (本轮无用户消息)", memories, personaSuggestion: null, marks: [] });
    return sseMessage({ model, blocks: [{ type: "text", text: json }], stopReason: "end_turn", usage: usage(json) });
  }
  if (req.system.includes("状态笔记")) {
    const note = inboundLines(req.request).map((l) => `- ${l.text}`).slice(-2).join("\n") || "- (无新内容)";
    return sseMessage({ model, blocks: [{ type: "text", text: note }], stopReason: "end_turn", usage: usage(note) });
  }
  const other = JSON.stringify({ memories: [], marks: [], results: [] });
  return sseMessage({ model, blocks: [{ type: "text", text: other }], stopReason: "end_turn", usage: usage(other) });
}

/** 替身端点:只接 POST …/v1/messages,其余 404。 */
export function createStandin(item: FixtureItem): typeof globalThis.fetch {
  const f = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!/\/v1\/messages(?:\?|$)/.test(url) || typeof init?.body !== "string") return new Response("not found", { status: 404 });
    return sseResponse(standinReply(item, init.body));
  };
  return f as typeof globalThis.fetch;
}
