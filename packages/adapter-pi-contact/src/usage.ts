// 用量回报与缓存断点(AC-39 ③⑤⑥、D22 第 3 节第 3、7 条)。mind.ts 与 compact.ts 共用,不做网络 I/O。
//   usageLine       :线路标识 = 服务商|端点主机名|模型。只取主机名——本机网关把令牌放在 URL 路径里,路径、端口、查询串、
//                     用户名口令一律不进线路;万一密钥出现在服务商或模型名里也隐去。
//   placeBreakpoints:发请求前(pi-ai 的 onPayload)把 cache_control 收拢到三处:工具声明末尾、第 1 块(system)末尾、
//                     本轮请求最后一条消息末尾,最多 3 个(上限 4,多了端点会整次拒绝);pi-ai 没标的区段不新增。
//   probeRequest    :按实际请求体算固定前缀哈希(工具声明 + system)与断点个数。
//   usageOf / report:把 pi-ai 回的 usage 换成 ModelUsage 交给宿主的回执口;回执口出错不影响模型调用。
import { createHash } from "node:crypto";
import type { ModelUsage, UsageSink } from "@g-group/kernel";

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => typeof x === "object" && x !== null && !Array.isArray(x);
const list = (x: unknown): Obj[] => (Array.isArray(x) ? x.filter(isObj) : []);
const blocksOf = (m: Obj): Obj[] => list(m.content);

/** 线路标识:服务商|端点主机名|模型。不含端点路径(本机网关的令牌在路径里)、端口、查询串、用户名口令与密钥 */
export function usageLine(provider: string, baseUrl: string, model: string, secret: string): string {
  let host = "?";
  try {
    host = new URL(baseUrl).hostname;
  } catch {
    /* 选项校验已拦下非法地址;这里只兜底 */
  }
  const line = `${provider}|${host}|${model}`;
  return secret ? line.split(secret).join("[密钥已隐去]") : line;
}

/** 实际请求体里 cache_control 的个数:工具声明、system 各段、每条消息的每个内容块 */
export function countBreakpoints(payload: unknown): number {
  if (!isObj(payload)) return 0;
  const marked = (xs: Obj[]) => xs.filter((x) => "cache_control" in x).length;
  return marked(list(payload.tools)) + marked(list(payload.system)) + list(payload.messages).reduce((n, m) => n + marked(blocksOf(m)), 0);
}

/**
 * 把断点收拢到工具声明末尾、第 1 块(system)末尾和本轮最后一条消息末尾(D22 第 3 节第 3 条,AC-39 ③「位于稳定段末尾与最新追加消息」)。
 * 用 pi-ai 选的那个 cache_control(含 ttl);pi-ai 在哪个区段没标就不在那里新增;一个都没标(cacheRetention none)就原样返回副本。
 * 返回新对象,不改入参。
 */
export function placeBreakpoints(payload: unknown): unknown {
  if (!isObj(payload)) return payload;
  const p = structuredClone(payload);
  const tools = list(p.tools);
  const system = list(p.system);
  const messages = list(p.messages);
  let cc: unknown;
  const strip = (xs: Obj[]): boolean => {
    let had = false;
    for (const x of xs) {
      if (!("cache_control" in x)) continue;
      cc ??= x.cache_control;
      had = true;
      delete x.cache_control;
    }
    return had;
  };
  const inTools = strip(tools);
  const inSystem = strip(system);
  let inMessages = false;
  for (const m of messages) if (strip(blocksOf(m))) inMessages = true;
  if (cc === undefined) return p;
  const at: Obj[] = [];
  const lastTool = tools.at(-1);
  if (inTools && lastTool) at.push(lastTool);
  const lastSystem = system.at(-1);
  if (inSystem && lastSystem) at.push(lastSystem);
  const lastMessage = messages.at(-1);
  const tail = lastMessage ? blocksOf(lastMessage).at(-1) : undefined;
  if (inMessages && tail) at.push(tail);
  for (const x of at) x.cache_control = cc;
  return p;
}

export interface RequestProbe {
  readonly prefixHash: string;
  readonly breakpoints: number;
}
const sha256 = (x: unknown): string => createHash("sha256").update(JSON.stringify(x ?? null), "utf8").digest("hex");

/** 按实际请求体算:固定前缀(工具声明 + system)哈希、断点个数 */
export function probeRequest(payload: unknown): RequestProbe {
  const p = isObj(payload) ? payload : {};
  const tools = Array.isArray(p.tools) && p.tools.length > 0 ? p.tools : null;
  return Object.freeze({ prefixHash: sha256({ tools, system: p.system ?? null }), breakpoints: countBreakpoints(p) });
}

/** pi-ai 回的 usage 换成 ModelUsage;没有请求体探测结果或四项全是 0(请求没发出去)返回 null */
export function usageOf(line: string, request: number, probe: RequestProbe | null, u: { input?: unknown; output?: unknown; cacheRead?: unknown; cacheWrite?: unknown } | undefined): ModelUsage | null {
  if (!probe || !u) return null;
  const n = (x: unknown): number => (typeof x === "number" && Number.isSafeInteger(x) && x >= 0 ? x : 0);
  const r: ModelUsage = { line, request, prefixHash: probe.prefixHash, breakpoints: probe.breakpoints, input: n(u.input), cacheRead: n(u.cacheRead), cacheWrite: n(u.cacheWrite), output: n(u.output) };
  return r.input + r.cacheRead + r.cacheWrite + r.output > 0 ? Object.freeze(r) : null;
}

/** 交给宿主的回执口;回执口出错不影响这次模型调用 */
export function report(sink: UsageSink | undefined, u: ModelUsage | null): void {
  if (!sink || !u) return;
  try {
    sink(u);
  } catch {
    /* 用量记录失败不影响联系人这一轮 */
  }
}
