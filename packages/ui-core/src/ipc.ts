// Electron 主进程收到渲染层请求时的第一道校验(技术栈与工程规则 §2:最小 preload + 校验 IPC 来源与参数)。
// 来源必须是本应用协议;请求必须是纯 JSON 数据(无访问器、无类实例、无函数、有深度和体积上限);
// 方法名交给调用方判断(主进程用 @g-group/api-contract 的方法表),参数形状再由合同 schema 逐项校验。

export const IPC_LIMITS = Object.freeze({ maxDepth: 32, maxBytes: 256 * 1024, maxKeys: 2000 });

export type IpcCheck = { ok: true; method: string; params: unknown } | { ok: false; error: string };
export type IpcOptions = { isMethod: (name: string) => boolean; devOrigin?: string; methodByteLimits?: Readonly<Record<string, number>> };

/** 来源只认本应用的 app:// 协议(开发时额外认传入的 dev 源)。 */
export function isTrustedOrigin(url: string, devOrigin?: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol === "app:" && u.host === "renderer") return true;
  if (devOrigin !== undefined && devOrigin !== "" && u.origin === devOrigin) return true;
  return false;
}

/** 判断一个值是不是纯 JSON 数据,返回问题说明;没问题返回 undefined。 */
export function jsonProblem(value: unknown): string | undefined {
  let keys = 0;
  const seen = new Set<object>();
  const walk = (v: unknown, depth: number): string | undefined => {
    if (depth > IPC_LIMITS.maxDepth) return `嵌套超过 ${IPC_LIMITS.maxDepth} 层`;
    if (v === null) return undefined;
    const t = typeof v;
    if (t === "string" || t === "boolean") return undefined;
    if (t === "number") return Number.isFinite(v) ? undefined : "数字必须是有限值";
    if (t !== "object") return `不支持的类型 ${t}`;
    const o = v as object;
    if (seen.has(o)) return "有循环引用";
    seen.add(o);
    const proto = Object.getPrototypeOf(o);
    if (Array.isArray(o)) {
      if (proto !== Array.prototype) return "数组原型被改过";
    } else if (proto !== Object.prototype && proto !== null) return "只接受普通对象";
    for (const k of Reflect.ownKeys(o)) {
      if (typeof k === "symbol") return "不接受 symbol 键";
      const d = Object.getOwnPropertyDescriptor(o, k);
      if (!d || !("value" in d)) return `字段 ${k} 是访问器`;
      if (Array.isArray(o) && k === "length") continue;
      if (++keys > IPC_LIMITS.maxKeys) return `字段超过 ${IPC_LIMITS.maxKeys} 个`;
      const r = walk(d.value, depth + 1);
      if (r) return r;
    }
    seen.delete(o);
    return undefined;
  };
  return walk(value, 0);
}

/** 校验一次渲染层调用:{ method, params }。 */
export function checkIpcRequest(req: unknown, senderUrl: string, opts: IpcOptions): IpcCheck {
  if (!isTrustedOrigin(senderUrl, opts.devOrigin)) return { ok: false, error: "来源不是本应用页面" };
  if (req === null || typeof req !== "object" || Array.isArray(req)) return { ok: false, error: "请求必须是对象" };
  const shape = jsonProblem(req);
  if (shape) return { ok: false, error: `请求不是纯数据:${shape}` };
  const r = req as { method?: unknown; params?: unknown };
  if (typeof r.method !== "string" || !opts.isMethod(r.method)) return { ok: false, error: `不认识的方法 ${String(r.method)}` };
  const size = JSON.stringify(r.params ?? null).length;
  // 大文件方法由宿主按合同显式给限额;普通方法仍保留默认上限,不由请求参数决定。
  const limit = opts.methodByteLimits && Object.hasOwn(opts.methodByteLimits, r.method) ? opts.methodByteLimits[r.method]! : IPC_LIMITS.maxBytes;
  if (!Number.isSafeInteger(limit) || limit <= 0 || size > limit) return { ok: false, error: `参数 ${size} 字节,超过上限 ${limit}` };
  return { ok: true, method: r.method, params: r.params ?? null };
}
