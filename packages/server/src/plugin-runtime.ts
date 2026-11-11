// 插件进程隔离运行时(AC-35 阶段 I 宿主契约;需求文档 §8.1 已定 17:插件交回的异常对象交进程隔离兜底)。
// 每个启用、带 entry 的插件一个子进程:node --permission,只能读自己的包目录和 runner,不给写文件、子进程、worker、原生扩展;
// 环境变量只有 G_GROUP_PLUGIN_ID(不继承宿主环境);工作目录是插件私有数据目录。
// 网络不在 Node 22 权限模型里:插件能联网,宿主没有拦,只按清单权限(net:fetch / net:post)告知用户 —— 这是如实的缺口,不冒充隔离。
// 进程之间只走 stdin/stdout 的 JSON 行,宿主拿到的只会是 JSON 数据;插件交回的数据再包成内核 plugin-contract 的
// DataSource / OutboundChannel 注册进内核注册表,外部事件盖章、B1/B2 外发记账都走内核现成逻辑。
// 超时、进程退出(含插件里没人接的拒绝、未捕获的异常、process.exit、堆超过上限)、非 JSON 输出、单行超过上限都把进程结束、
// 在途调用收成受控失败;下次调用重新起进程(AC-58:插件的故障只落在插件自己)。回应只按请求 id 对上,旧 id、未知 id 丢弃。
// 外发账本在内核注册表里(内存):宿主重启或卸载插件后丢失,见收据第 7 栏。
import { type ChildProcess, spawn } from "node:child_process";
import { lstatSync, mkdirSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { type PluginRegistry, type PullResult, type SendResult, createRegistry } from "@g-group/kernel";
import { HostError } from "./db.ts";

export const PLUGIN_RUNNER = fileURLToPath(new URL("../runtime/plugin-runner.mjs", import.meta.url));

export interface PluginTarget {
  readonly id: string;
  /** 已安装的包目录(宿主数据目录 plugins/<id>/<version>/) */
  readonly dir: string;
  /** 清单里的 entry(包内相对路径) */
  readonly entry: string;
  /** 插件私有数据目录,作进程工作目录 */
  readonly dataDir: string;
  readonly config: unknown;
  /** 清单声明的类型;进程自报的类型必须在其中 */
  readonly kinds: readonly string[];
}
export interface PluginRuntimeOptions {
  /** 宿主墙钟(毫秒),外部事件 receivedAt 用它 */
  readonly now?: () => number;
  /** pull 单次超时;默认 15 秒 */
  readonly callTimeoutMs?: number;
  /** 外发超时(内核记 DeliveryUnknown);默认 15 秒 */
  readonly sendTimeoutMs?: number;
  /** 启动(加载 + init)超时;默认 15 秒 */
  readonly startTimeoutMs?: number;
  /** 插件单行输出上限(字节);默认 4 MB */
  readonly maxLineBytes?: number;
  /** 插件进程的 JS 堆上限(MB,--max-old-space-size);超了 V8 结束插件进程,宿主不受影响。默认 256 */
  readonly maxHeapMb?: number;
  /** 外发超时(内核已记 DeliveryUnknown)之后再等多久才结束不回应的插件进程(毫秒);这段时间里到的迟到回执由内核丢弃。默认 200 */
  readonly sendGraceMs?: number;
  /** 宿主配置的预加载模块(绝对路径),在插件代码之前载入插件进程;只能由宿主给,插件改不了。
   *  测试用它把插件进程里的 fetch 换成替身(门禁沙箱禁网);它也只得到对自己这个文件的读权限。 */
  readonly preload?: string;
}
/** 进程就绪后插件自述的渠道(交给 gate 绑定)。 */
export interface ChannelInfo {
  readonly endpoint: string;
  readonly idempotency: "none" | "action-id";
  readonly windowMs: number | null;
}
/** 外发闸门(红提交空壳:还不调用)。 */
export type SendGate = (ch: ChannelInfo) => SendResult | null;
type Describe =
  | { readonly kind: "data-source"; readonly sources: readonly string[] }
  | { readonly kind: "outbound-channel"; readonly idempotency: "none" | "action-id"; readonly idempotencyWindowMs: number | null; readonly endpoint: string | null };

interface Pending {
  readonly resolve: (v: unknown) => void;
  readonly reject: (e: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

/** 一个插件子进程:JSON 行请求/回应,带超时、输出上限与退出收尾。 */
class PluginProcess {
  readonly child: ChildProcess;
  private buf = "";
  private stderr = "";
  private seq = 0;
  private readonly pending = new Map<number, Pending>();
  private ended: string | null = null;

  constructor(t: { id: string; dir: string; entry: string; cwd: string; preload: string | null }, limits: { maxLineBytes: number; maxHeapMb: number }) {
    const maxLineBytes = limits.maxLineBytes;
    const pre = t.preload ? [`--allow-fs-read=${t.preload}`, "--import", pathToFileURL(t.preload).href] : [];
    this.child = spawn(
      process.execPath,
      ["--permission", `--max-old-space-size=${limits.maxHeapMb}`, `--allow-fs-read=${t.dir}${path.sep}`, `--allow-fs-read=${PLUGIN_RUNNER_REAL()}`, ...pre, PLUGIN_RUNNER_REAL(), t.entry],
      { cwd: t.cwd, env: { G_GROUP_PLUGIN_ID: t.id }, stdio: ["pipe", "pipe", "pipe"] },
    );
    this.child.stdout?.setEncoding("utf8");
    this.child.stdout?.on("data", (chunk: string) => {
      if (this.ended) return;
      this.buf += chunk;
      let i = this.buf.indexOf("\n");
      while (i >= 0) {
        const line = this.buf.slice(0, i);
        this.buf = this.buf.slice(i + 1);
        if (Buffer.byteLength(line) > maxLineBytes) return this.kill(`插件单行输出超过 ${maxLineBytes} 字节上限,已结束插件进程`);
        if (line.trim()) this.onLine(line);
        if (this.ended) return;
        i = this.buf.indexOf("\n");
      }
      if (Buffer.byteLength(this.buf) > maxLineBytes) this.kill(`插件单行输出超过 ${maxLineBytes} 字节上限,已结束插件进程`);
    });
    this.child.stderr?.setEncoding("utf8");
    this.child.stderr?.on("data", (d: string) => {
      this.stderr = (this.stderr + d).slice(-2000);
    });
    this.child.stdin?.on("error", () => {
      /* 进程已退出时写 stdin 会 EPIPE,由 exit 收尾 */
    });
    this.child.on("error", (e) => this.finish(`插件进程起不来:${e.message}`));
    this.child.on("exit", (code, signal) => {
      const tail = this.stderr.trim() ? `;stderr:${this.stderr.trim().slice(-500)}` : "";
      this.finish(`插件进程退出(code=${code ?? "null"},signal=${signal ?? "null"})${tail}`);
    });
  }
  get alive() {
    return this.ended === null;
  }
  get pid() {
    return this.child.pid ?? null;
  }
  private onLine(line: string) {
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      this.kill("插件往标准输出写了非 JSON 内容,按协议违规结束插件进程");
      return;
    }
    if (typeof msg !== "object" || msg === null || Array.isArray(msg)) {
      this.kill("插件回应不是 JSON 对象,按协议违规结束插件进程");
      return;
    }
    const m = msg as { id?: unknown; ok?: unknown; result?: unknown; error?: unknown };
    const p = typeof m.id === "number" ? this.pending.get(m.id) : undefined;
    if (!p) return;
    this.pending.delete(m.id as number);
    clearTimeout(p.timer);
    if (m.ok === true) p.resolve(m.result ?? null);
    else p.reject(new Error(typeof m.error === "string" ? m.error.slice(0, 2000) : "插件报错但没给原因"));
  }
  call(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (this.ended) return Promise.reject(new Error(this.ended));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.kill(`插件 ${timeoutMs}ms 没有回应,已结束插件进程`), timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin?.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }
  /** 结束进程:在途调用一律以 reason 失败。 */
  kill(reason: string) {
    this.finish(reason);
    this.child.kill("SIGKILL");
  }
  private finish(reason: string) {
    if (this.ended === null) this.ended = reason;
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      this.pending.delete(id);
      p.reject(new Error(reason));
    }
  }
}

let runnerReal: string | null = null;
const PLUGIN_RUNNER_REAL = () => (runnerReal ??= realpathSync(PLUGIN_RUNNER));

/** 包目录检查:入口必须是包内的 .mjs;包里不能有符号链接(Node 权限模型会跟着符号链接读到包外)。 */
function checkPackage(t: PluginTarget): { dir: string; entry: string } {
  if (!t.entry.endsWith(".mjs")) throw new HostError("unavailable", `插件 ${t.id} 的入口必须是 .mjs(宿主只按 ES 模块加载,免得去读包外的 package.json)`);
  const dir = realpathSync(t.dir);
  const walk = (d: string, depth: number, seen: { n: number }) => {
    for (const name of readdirSync(d)) {
      if (++seen.n > 10_000) throw new HostError("unavailable", `插件 ${t.id} 的包文件太多`);
      const full = path.join(d, name);
      const st = lstatSync(full);
      if (st.isSymbolicLink()) throw new HostError("forbidden", `插件包里有符号链接 ${path.relative(dir, full)},不启动(权限模型会跟着符号链接读到包外)`);
      if (st.isDirectory() && depth < 32) walk(full, depth + 1, seen);
    }
  };
  walk(dir, 0, { n: 0 });
  const entry = path.resolve(dir, t.entry);
  if (!entry.startsWith(dir + path.sep)) throw new HostError("invalid_params", "entry 不能指到包目录外");
  return { dir, entry };
}

/** 进程自报的描述:只认声明过的类型与字段,其余忽略。 */
function parseDescribe(raw: unknown, t: PluginTarget): Describe {
  const bad = (why: string) => new HostError("unavailable", `插件 ${t.id} 的自述不合格:${why}`);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw bad("不是对象");
  const d = raw as Record<string, unknown>;
  if (d.kind !== "data-source" && d.kind !== "outbound-channel") throw bad("kind 必须是 data-source 或 outbound-channel(界面扩展不需要运行)");
  if (!t.kinds.includes(d.kind)) throw bad(`运行时自报 ${d.kind},清单没有声明`);
  if (d.kind === "data-source") {
    const sources = Array.isArray(d.sources) ? d.sources.filter((s): s is string => typeof s === "string" && s.length > 0 && s.length <= 4096) : [];
    return { kind: "data-source", sources: [...new Set(sources)].slice(0, 100) };
  }
  const idempotency = d.idempotency === "action-id" ? "action-id" : d.idempotency === "none" ? "none" : null;
  if (!idempotency) throw bad("idempotency 必须是 action-id 或 none");
  const w = d.idempotencyWindowMs;
  if (idempotency === "action-id" && !(typeof w === "number" && Number.isFinite(w) && w > 0)) throw bad("B1 渠道要给正数 idempotencyWindowMs");
  const endpoint = typeof d.endpoint === "string" && d.endpoint.length > 0 && d.endpoint.length <= 4096 ? d.endpoint : null;
  return { kind: "outbound-channel", idempotency, idempotencyWindowMs: idempotency === "action-id" ? (w as number) : null, endpoint };
}

interface Live {
  readonly proc: PluginProcess;
  readonly desc: Describe;
}

export interface PullOutcome {
  readonly events: Extract<PullResult, { ok: true }>["events"];
  readonly rejected: { sourceId: string; index: number; reason: string }[];
  readonly failures: { sourceId: string; reason: string; detail: string }[];
}

export class PluginRuntime {
  private readonly o: Required<Omit<PluginRuntimeOptions, "now" | "preload">> & { now: () => number; preload: string | null };
  private readonly live = new Map<string, Live>();
  private readonly starting = new Map<string, Promise<Live>>();
  /** 每个插件一个内核注册表:外发账本按插件分开,卸载时整份丢掉 */
  private readonly registries = new Map<string, { reg: PluginRegistry; registered: string | null }>();

  constructor(o: PluginRuntimeOptions = {}) {
    this.o = {
      now: o.now ?? Date.now,
      callTimeoutMs: o.callTimeoutMs ?? 15_000,
      sendTimeoutMs: o.sendTimeoutMs ?? 15_000,
      startTimeoutMs: o.startTimeoutMs ?? 15_000,
      maxLineBytes: o.maxLineBytes ?? 4 * 1024 * 1024,
      maxHeapMb: o.maxHeapMb ?? 256,
      sendGraceMs: o.sendGraceMs ?? 200,
      preload: o.preload ? realpathSync(o.preload) : null,
    };
  }

  pid(id: string) {
    const l = this.live.get(id);
    return l?.proc.alive ? l.proc.pid : null;
  }

  private ensure(t: PluginTarget): Promise<Live> {
    const cur = this.live.get(t.id);
    if (cur?.proc.alive) return Promise.resolve(cur);
    const s = this.starting.get(t.id);
    if (s) return s;
    const p = this.start(t).finally(() => this.starting.delete(t.id));
    this.starting.set(t.id, p);
    return p;
  }

  private async start(t: PluginTarget): Promise<Live> {
    const pkg = checkPackage(t);
    mkdirSync(t.dataDir, { recursive: true });
    const proc = new PluginProcess({ id: t.id, dir: pkg.dir, entry: pkg.entry, cwd: realpathSync(t.dataDir), preload: this.o.preload }, { maxLineBytes: this.o.maxLineBytes, maxHeapMb: this.o.maxHeapMb });
    let desc: Describe;
    try {
      desc = parseDescribe(await proc.call("init", { config: t.config }, this.o.startTimeoutMs), t);
    } catch (e) {
      proc.kill("启动失败");
      if (e instanceof HostError) throw e;
      throw new HostError("unavailable", `插件 ${t.id} 启动失败:${(e as Error).message}`);
    }
    const live: Live = { proc, desc };
    this.live.set(t.id, live);
    try {
      this.register(t.id, desc);
    } catch (e) {
      proc.kill("注册失败");
      this.live.delete(t.id);
      throw e;
    }
    return live;
  }

  /** 把进程包成内核契约对象注册;函数委托给「当前活着的进程」,进程重启不换注册,只有自述变了才 reregister。 */
  private register(id: string, desc: Describe) {
    if (desc.kind === "data-source" ? desc.sources.length === 0 : desc.endpoint === null) return;
    let slot = this.registries.get(id);
    if (!slot) {
      const { now, sendTimeoutMs } = this.o;
      slot = { reg: createRegistry({ now, sendTimeoutMs }), registered: null };
      this.registries.set(id, slot);
    }
    const key = JSON.stringify(desc);
    if (slot.registered === key) return;
    const call = (method: string, params: unknown, timeoutMs: number) => this.callLive(id, method, params, timeoutMs);
    const candidate =
      desc.kind === "data-source"
        ? { kind: desc.kind, id, sources: [...desc.sources], pull: (sourceId: string) => call("pull", { sourceId }, this.o.callTimeoutMs) }
        : {
            kind: desc.kind,
            id,
            idempotency: desc.idempotency,
            ...(desc.idempotencyWindowMs !== null ? { idempotencyWindowMs: desc.idempotencyWindowMs } : {}),
            endpoint: desc.endpoint,
            // 比内核的外发超时多留一段宽限:内核先记 timeout(DeliveryUnknown),宽限内到的迟到回执内核不再理会,过了宽限才结束不回应的进程
            send: (request: unknown) => call("send", { request }, this.o.sendTimeoutMs + this.o.sendGraceMs),
          };
    const r = slot.registered === null ? slot.reg.register(candidate) : slot.reg.reregister(candidate);
    if (!r.ok) throw new HostError("conflict", `插件 ${id} 注册进内核失败:${r.reason} ${r.detail}`);
    slot.registered = key;
  }

  private async callLive(id: string, method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const l = this.live.get(id);
    if (!l?.proc.alive) throw new Error("插件进程已结束");
    return l.proc.call(method, params, timeoutMs);
  }

  async pull(t: PluginTarget, sourceId?: string): Promise<PullOutcome> {
    const first = await this.ensure(t);
    if (first.desc.kind !== "data-source") throw new HostError("invalid_params", `插件 ${t.id} 不是数据源`);
    const sources = sourceId === undefined ? first.desc.sources : [sourceId];
    if (sources.length === 0) throw new HostError("invalid_params", `插件 ${t.id} 还没有可拉取的来源,先在配置里填写`);
    const out: PullOutcome = { events: [], rejected: [], failures: [] };
    for (const s of sources) {
      // 上一个来源把进程结束了(超时、崩溃)就先重起,注册不变
      await this.ensure(t);
      const reg = this.registries.get(t.id)!.reg;
      const r = await reg.pull(t.id, s);
      if (!r.ok) {
        out.failures.push({ sourceId: s, reason: r.reason, detail: r.detail });
        continue;
      }
      out.events.push(...r.events);
      for (const x of r.rejected) out.rejected.push({ sourceId: s, index: x.index, reason: x.reason });
    }
    return out;
  }

  async send(t: PluginTarget, actionId: string, payload: string, _gate?: SendGate): Promise<SendResult> {
    const l = await this.ensure(t);
    if (l.desc.kind !== "outbound-channel") throw new HostError("invalid_params", `插件 ${t.id} 不是输出渠道`);
    if (l.desc.endpoint === null) throw new HostError("invalid_params", `插件 ${t.id} 还没有接收端,先在配置里填写`);
    return this.registries.get(t.id)!.reg.send(t.id, { action_id: actionId, payload });
  }

  /** 结束插件进程(停用、改配置、更新时);外发账本保留。 */
  stop(id: string) {
    const l = this.live.get(id);
    this.live.delete(id);
    l?.proc.kill("插件已停止");
  }
  /** 卸载:结束进程并丢掉这个插件的注册与外发账本。 */
  forget(id: string) {
    this.stop(id);
    this.registries.delete(id);
  }
  close() {
    for (const id of [...this.live.keys()]) this.stop(id);
  }
}
