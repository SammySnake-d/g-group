// 状态笔记压缩器的 pi 实现(D06 第 2 小节第 3 块、D25 第 8 节;AC-32 ③)。
// 一次独立、无状态的模型调用:system = 压缩说明(含 STATE_NOTE_GUIDE),user = 旧笔记 + 本轮材料(+ 字节上限);不带工具、
// 不带联系人五块与人设,所以不进联系人会话、不动第 1 块缓存前缀。模型必须等于请求里联系人的说话模型,不一致一次都不发;
// 端点报错如实抛出(隐去密钥),不换模型或厂商重试。压缩用哪个模型、配置失配怎么拦截归 D 件(AC-32),这里只按联系人的说话模型调用。
import { type CompactRequest, type ContactCompactor, plainData, type ReflectRequest, type ReflectResult, STATE_NOTE_GUIDE, type UsageSink } from "@g-group/kernel";
import { PiContactMindError } from "./errors.ts";
import type { PiContactMindOptions } from "./mind.ts";
import { resolveOptions, sessionFor } from "./request.ts";
import { textRequest } from "./text-request.ts";

export type PiCompactorOptions = Omit<PiContactMindOptions, "maxRequestsPerRound" | "cacheRetention">;

const SYSTEM = [
  "你替一位联系人整理它的状态笔记。你不和任何人对话,只输出新的状态笔记正文,不加解释、不加前后缀。",
  STATE_NOTE_GUIDE,
  "旧笔记里仍然有效的事实保留;本轮材料里新出现的要求、改动和结果并进去;已经了结的事删掉。不要编造材料里没有的进展。",
].join("\n");

function userText(req: CompactRequest): string {
  const prev = req.previous === null ? "(没有旧笔记)" : req.previous;
  const limit = req.maxBytes === null ? "" : `\n新笔记不超过 ${req.maxBytes} 字节(UTF-8)。`;
  if (req.kind === "shrink") return `[旧状态笔记]\n${prev}\n\n请在不丢掉仍有效的要求、对象、数值和条件的前提下缩写这份笔记。${limit}`;
  return `[旧状态笔记]\n${prev}\n\n${req.material}\n请据此写出新的状态笔记。${limit}`;
}

const REFLECT_SYSTEM = [
  "你在一轮对话结束、本轮原文移出窗口前,替一位联系人做三件事,只输出一个 JSON 对象,不加别的文字:",
  "{\"note\": 新状态笔记或 null, \"memories\": [{\"title\", \"text\", \"anchors\": [...], \"relation\": \"change\"|\"refine\"|\"conflict\"|null, \"target\": 记忆id或null}], \"personaSuggestion\": 一句话或 null}",
  "1 状态笔记:材料里写明「模型已写笔记」时 note 给 null;否则按下面的写法写。",
  STATE_NOTE_GUIDE,
  "每条记忆必须给 roomId/sourceSeq/evidence，evidence 是可用来源中用户直接声明的逐字原话；不得从问句、假设、引用推断。",
  "2 记忆:按这位联系人的人设与职责,检查本轮有没有以后用得上的事——用户的偏好与纠正、定下的规矩、走通或走不通的做法。没有值得记的就给空数组,不要为了记而记。",
  "  anchors 写适用范围:room:<会话id>、user:<uid>、task:<任务id>、tool:<工具名>、path:<路径>;只有用户原话说了「以后都/所有」才用 global。",
  "  与已有记忆内容相同就不要再列;改变了某条已有结论填 change 与 target;只补充细节填 refine;与某条矛盾填 conflict。",
  "3 人格:不要改人格。只有本轮明确显示人设需要调整时,personaSuggestion 写一句建议,否则给 null。",
].join("\n");

function reflectText(req: ReflectRequest): string {
  const prev = req.previous === null ? "(没有旧笔记)" : req.previous;
  const neighbors = req.neighbors.length === 0 ? "(无)" : req.neighbors.map((n) => `${n.id} · ${n.title}:${n.body}`).join("\n");
  const written = req.noteWritten === null ? "(模型本轮没写笔记,请写)" : `模型已写笔记(不要覆盖):\n${req.noteWritten}`;
  const limit = req.maxBytes === null ? "" : `\n新笔记不超过 ${req.maxBytes} 字节(UTF-8)。`;
  return `[逐条可用来源]
${JSON.stringify(req.sources ?? [])}
[联系人人设与职责]\n${req.contact.persona || "(未设置)"}\n\n[旧状态笔记]\n${prev}\n\n[本轮状态笔记]\n${written}\n\n[已有相关记忆]\n${neighbors}\n\n${req.material}${limit}`;
}

const RELS = new Set(["change", "refine", "conflict"]);
function parseReflect(text: string, noteWritten: boolean): ReflectResult {
  const bad = (why: string): never => { throw new PiContactMindError("provider-error", `检查输出不合格:${why}`); };
  const a = text.indexOf("{");
  const b = text.lastIndexOf("}");
  if (a < 0 || b < a) return bad("找不到 JSON 对象");
  let v: unknown;
  try { v = JSON.parse(text.slice(a, b + 1)); } catch { return bad("不是合法 JSON"); }
  if (typeof v !== "object" || v === null || Array.isArray(v)) return bad("必须是对象");
  const o = v as Record<string, unknown>;
  const str = (x: unknown) => typeof x === "string" && x.trim() !== "";
  if (o.note !== null && !str(o.note)) return bad("note 必须是非空字符串或 null");
  if (o.personaSuggestion !== null && o.personaSuggestion !== undefined && !str(o.personaSuggestion)) return bad("personaSuggestion 必须是非空字符串或 null");
  if (!Array.isArray(o.memories)) return bad("memories 必须是数组");
  const memories = o.memories.map((m: unknown, i: number) => {
    const r = m as Record<string, unknown> | null;
    if (typeof r !== "object" || r === null) return bad(`memories[${i}] 必须是对象`);
    if (!str(r.title) || !str(r.text)) return bad(`memories[${i}] 缺 title 或 text`);
    if (!Array.isArray(r.anchors) || r.anchors.length === 0 || !r.anchors.every(str)) return bad(`memories[${i}].anchors 必须是非空字符串数组`);
    const relation = r.relation ?? null;
    if (relation !== null && !RELS.has(relation as string)) return bad(`memories[${i}].relation 只能是 change / refine / conflict / null`);
    const target = r.target ?? null;
    if (target !== null && !str(target)) return bad(`memories[${i}].target 必须是字符串或 null`);
    if ((relation === null) !== (target === null)) return bad(`memories[${i}].relation 和 target 必须一起提供`);
    return Object.freeze({ ...(typeof r.roomId === "string" ? { roomId: r.roomId } : {}), ...(Number.isSafeInteger(r.sourceSeq) ? { sourceSeq: r.sourceSeq as number } : {}), ...(typeof r.evidence === "string" ? { evidence: r.evidence } : {}), title: r.title as string, text: r.text as string, anchors: Object.freeze([...(r.anchors as string[])]), relation: relation as "change" | "refine" | "conflict" | null, target: target as string | null });
  });
  return Object.freeze({ note: noteWritten ? null : ((o.note as string | null) ?? null), memories: Object.freeze(memories), personaSuggestion: (o.personaSuggestion as string | null | undefined) ?? null });
}

export function createPiCompactor(opts: PiCompactorOptions): ContactCompactor {
  const cfg = resolveOptions(opts, "compactor");
  async function compact(input: CompactRequest, signal: AbortSignal, usage?: UsageSink): Promise<string> {
    const p = plainData(input, "压缩请求");
    if (!p.ok) throw new PiContactMindError("invalid-request", `压缩请求不合格:${p.path} ${p.why}`);
    const req = p.value as CompactRequest;
    const speaking = req?.contact?.speakingModel;
    if (typeof speaking !== "string") throw new PiContactMindError("invalid-request", "contact.speakingModel 必须是字符串");
    if (speaking !== cfg.model) throw new PiContactMindError("model-mismatch", `联系人的说话模型是 ${speaking},这个压缩器绑定的是 ${cfg.model};压缩只用说话模型,不静默换模`);
    if (req.kind !== "round-note" && req.kind !== "shrink") throw new PiContactMindError("invalid-request", "kind 只能是 round-note 或 shrink");
    return call(SYSTEM, userText(req), req.contact.id, signal, usage);
  }
  function call(system: string, prompt: string, contactId: string, signal: AbortSignal, usage?: UsageSink): Promise<string> {
    const sessionId = sessionFor(cfg, "note", contactId);
    return textRequest(cfg, { system, prompt, signal, failureLabel: "压缩请求失败", empty: "压缩器返回了空笔记", ...(sessionId ? { sessionId } : {}), ...(usage ? { usage } : {}) });
  }
  async function reflect(input: ReflectRequest, signal: AbortSignal, usage?: UsageSink): Promise<ReflectResult> {
    const p = plainData(input, "检查请求");
    if (!p.ok) throw new PiContactMindError("invalid-request", `检查请求不合格:${p.path} ${p.why}`);
    const req = p.value as ReflectRequest;
    const speaking = req?.contact?.speakingModel;
    if (typeof speaking !== "string") throw new PiContactMindError("invalid-request", "contact.speakingModel 必须是字符串");
    if (speaking !== cfg.model) throw new PiContactMindError("model-mismatch", `联系人的说话模型是 ${speaking},这个压缩器绑定的是 ${cfg.model};检查只用说话模型,不静默换模`);
    if (!Array.isArray(req.neighbors)) throw new PiContactMindError("invalid-request", "neighbors 必须是数组");
    const text = await call(REFLECT_SYSTEM, reflectText(req), req.contact.id, signal, usage);
    return parseReflect(text, req.noteWritten !== null);
  }
  return Object.freeze({ compact, reflect });
}
