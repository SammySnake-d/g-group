// 插件:市场目录、安装、启停、配置、更新、卸载,以及插件声明的 slash 命令(用户 #719:「连插件市场和安装的入口都没有」)。
// 插件包 = 一个目录,根上有 plugin.json(清单)。市场 = 一个 catalog.json,列出可装插件与包目录。
// 安装先校验清单、核对用户勾选的权限覆盖清单声明的全部权限,再把包复制进宿主数据目录 plugins/<id>/<version>/,与来源解耦。
// 插件代码不在宿主进程里加载:带 entry 的插件经 PluginRuntime 在隔离子进程里执行(需求文档 §8.1 已定 17 的兜底),
// 这里只做安装态、调用前的启用/类型检查与结果投影。
// URL 安装:下载 .tgz(大小上限、可选 sha256 核对),在宿主数据目录 plugin-downloads/ 下解包(拒绝绝对路径、..、链接条目),
// 之后与本地目录安装同一条路:校验清单、核对权限、复制进 plugins/<id>/<version>/;临时目录用完即删。
// 签名校验不在首版(§8.1 已定:插件市场首版只做版本号显示与更新,在线提交/签名/分发不在首版),只记内容 sha256。
import { createHash, randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import type { MarketplaceEntry, PluginView, SlashCommand } from "@g-group/api-contract";
import { SlashCommand as SlashCommandSchema, arr, formatIssues, json, obj, oneOf, opt, str } from "@g-group/api-contract";
import { type Db, HostError, all, one, run } from "./db.ts";
import type { PluginRuntime, PluginTarget } from "./plugin-runtime.ts";
import { extractTo, readTgz } from "./untar.ts";

const KIND = oneOf(["data-source", "outbound-channel", "ui-extension"] as const);
/** plugin.json 的形状。命令沿用合同里的 SlashCommand,但 source/pluginId/targetContactId 由宿主填。 */
export const PluginManifest = obj({
  id: str({ min: 1, max: 64, pattern: /^[a-z0-9][a-z0-9-]*$/ }),
  name: str({ min: 1, max: 100 }),
  version: str({ min: 1, max: 50, pattern: /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/ }),
  publisher: str({ min: 1, max: 100 }),
  description: str({ max: 5000 }),
  kinds: arr(KIND),
  permissions: arr(obj({ key: str({ min: 1, max: 100 }), description: str({ max: 500 }) })),
  commands: opt(arr(obj({ name: SlashCommandSchema.shape.name, description: str({ max: 200 }), args: SlashCommandSchema.shape.args }), { max: 20 })),
  configSchema: opt(json()),
  entry: opt(str({ min: 1, max: 200 })),
  icon: opt(str({ max: 2048 })),
});
type Manifest = NonNullable<Extract<ReturnType<typeof PluginManifest.check>, { ok: true }>["value"]>;
const Catalog = obj({ entries: arr(obj({ id: str({ min: 1, max: 64 }), dir: str({ min: 1, max: 4096 }) })) });

interface Row {
  id: string;
  version: string;
  source: "marketplace" | "local-path" | "url";
  origin: string;
  dir: string;
  enabled: number;
  status: PluginView["status"];
  error: string | null;
  manifest: string;
  config: string | null;
  granted: string;
  installed_at: string;
}

function readManifest(dir: string): Manifest {
  const f = path.join(dir, "plugin.json");
  if (!existsSync(f)) throw new HostError("invalid_params", `${dir} 里没有 plugin.json`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(f, "utf8"));
  } catch (e) {
    throw new HostError("invalid_params", `plugin.json 不是合法 JSON:${(e as Error).message}`);
  }
  const m = PluginManifest.check(raw);
  if (!m.ok) throw new HostError("invalid_params", `plugin.json 不合格:${formatIssues(m.issues)}`);
  if (m.value.kinds.length === 0) throw new HostError("invalid_params", "plugin.json 至少声明一种插件类型");
  if (m.value.entry) {
    const e = path.resolve(dir, m.value.entry);
    if (!e.startsWith(path.resolve(dir) + path.sep)) throw new HostError("invalid_params", "entry 不能指到包目录外");
  }
  return m.value;
}
const cmp = (a: string, b: string) => {
  const pa = a.split(/[.-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
  const pb = b.split(/[.-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x === y) continue;
    return typeof x === "number" && typeof y === "number" ? x - y : String(x) < String(y) ? -1 : 1;
  }
  return 0;
};

export interface PluginStoreDeps {
  readonly db: Db;
  /** 宿主数据目录:安装的插件包复制到 <dataDir>/plugins/<id>/<version>/ */
  readonly dataDir: string;
  /** 市场目录文件(catalog.json);没有就是空市场 */
  readonly catalogFile: string | null;
  readonly now: () => string;
  readonly emit: (v: PluginView | { removed: string }) => void;
  readonly commandsChanged: () => void;
  /** 插件进程运行时;带 entry 的插件经它在隔离子进程里执行 */
  readonly runtime: PluginRuntime;
  /** URL 安装的下载函数;默认全局 fetch */
  readonly fetch?: (url: string) => Promise<Response>;
  /** URL 安装的下载上限(字节),默认 20 MB;解包后上限为它的 4 倍 */
  readonly maxDownloadBytes?: number;
}
type InstallSource = { kind: "marketplace"; id: string; version?: string } | { kind: "local-path"; path: string } | { kind: "url"; url: string; sha256?: string };
/** URL 来源的 origin 列存 JSON:地址、实际内容 sha256、是否与用户给的值核对过 */
interface UrlOrigin {
  url: string;
  sha256: string;
  verified: boolean;
}

export class PluginStore {
  private readonly d: PluginStoreDeps;
  constructor(deps: PluginStoreDeps) {
    this.d = deps;
  }
  private catalog(): { id: string; dir: string; manifest: Manifest }[] {
    if (!this.d.catalogFile || !existsSync(this.d.catalogFile)) return [];
    const base = path.dirname(this.d.catalogFile);
    const c = Catalog.check(JSON.parse(readFileSync(this.d.catalogFile, "utf8")));
    if (!c.ok) throw new HostError("internal", `市场目录不合格:${formatIssues(c.issues)}`);
    const out: { id: string; dir: string; manifest: Manifest }[] = [];
    for (const e of c.value.entries) {
      const dir = path.resolve(base, e.dir);
      try {
        const m = readManifest(dir);
        if (m.id === e.id) out.push({ id: e.id, dir, manifest: m });
      } catch {
        /* 坏条目不进市场 */
      }
    }
    return out;
  }
  marketplace(q: { query?: string; kind?: string }): MarketplaceEntry[] {
    const installed = new Set(all<{ id: string }>(this.d.db, "SELECT id FROM gg_plugins").map((r) => r.id));
    const needle = q.query?.trim().toLowerCase();
    return this.catalog()
      .filter((e) => !needle || `${e.manifest.name} ${e.manifest.description} ${e.id}`.toLowerCase().includes(needle))
      .filter((e) => !q.kind || e.manifest.kinds.includes(q.kind as Manifest["kinds"][number]))
      .map((e) => ({
        id: e.id,
        name: e.manifest.name,
        publisher: e.manifest.publisher,
        description: e.manifest.description,
        icon: e.manifest.icon ?? null,
        kinds: e.manifest.kinds,
        latestVersion: e.manifest.version,
        commands: (e.manifest.commands ?? []).map((c) => c.name),
        permissions: e.manifest.permissions,
        installed: installed.has(e.id),
      }));
  }
  private row(id: string): Row {
    const r = one<Row>(this.d.db, "SELECT * FROM gg_plugins WHERE id = ?", id);
    if (!r) throw new HostError("not_found", `没有安装插件 ${id}`);
    return r;
  }
  view(r: Row): PluginView {
    const m = JSON.parse(r.manifest) as Manifest;
    const latest = r.source === "marketplace" ? (this.catalog().find((e) => e.id === r.id)?.manifest.version ?? null) : null;
    const url = r.source === "url" ? (JSON.parse(r.origin) as UrlOrigin) : null;
    return {
      id: r.id,
      name: m.name,
      version: r.version,
      latestVersion: latest && cmp(latest, r.version) > 0 ? latest : null,
      kinds: m.kinds,
      source: r.source,
      enabled: !!r.enabled,
      status: r.status,
      error: r.error,
      permissions: m.permissions,
      configSchema: m.configSchema ?? null,
      config: r.config ? (JSON.parse(r.config) as unknown) : null,
      commands: (m.commands ?? []).map((c) => c.name),
      installedAt: r.installed_at,
      executable: !!m.entry,
      ...(url ? { integrity: { sha256: url.sha256, verified: url.verified } } : {}),
    };
  }
  list(): PluginView[] {
    return all<Row>(this.d.db, "SELECT * FROM gg_plugins ORDER BY installed_at, id").map((r) => this.view(r));
  }
  get(id: string): PluginView {
    return this.view(this.row(id));
  }
  async install(source: InstallSource, granted: string[]): Promise<PluginView> {
    if (source.kind !== "url") return this.installFrom(source, granted);
    const bytes = await this.download(source.url);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (source.sha256 !== undefined && source.sha256 !== sha256) throw new HostError("forbidden", `下载内容的 sha256 是 ${sha256},与给定的不符,不安装`);
    const max = this.maxDownload();
    const files = readTgz(bytes, { maxBytes: 4 * max, maxEntries: 5000 });
    const tmpRoot = path.join(this.d.dataDir, "plugin-downloads");
    const tmp = path.join(tmpRoot, randomUUID());
    try {
      mkdirSync(tmp, { recursive: true });
      extractTo(files, tmp);
      const top = readdirSync(tmp);
      const root = existsSync(path.join(tmp, "plugin.json")) ? tmp : top.length === 1 && existsSync(path.join(tmp, top[0]!, "plugin.json")) ? path.join(tmp, top[0]!) : null;
      if (!root) throw new HostError("invalid_params", "包里没有 plugin.json(根目录或唯一的顶层目录里)");
      const origin: UrlOrigin = { url: source.url, sha256, verified: source.sha256 !== undefined };
      return this.installFrom({ kind: "url", dir: root, origin: JSON.stringify(origin) }, granted);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
      if (existsSync(tmpRoot) && readdirSync(tmpRoot).length === 0) rmSync(tmpRoot, { recursive: true, force: true });
    }
  }
  private maxDownload() {
    return this.d.maxDownloadBytes ?? 20 * 1024 * 1024;
  }
  /** 下载插件包:非 2xx、跳到非 https、超过上限都拒绝;边读边计数,超了就停。 */
  private async download(url: string): Promise<Buffer> {
    const max = this.maxDownload();
    let res: Response;
    try {
      res = await (this.d.fetch ?? ((u: string) => fetch(u)))(url);
    } catch (e) {
      throw new HostError("unavailable", `下载插件包失败:${(e as Error).message}`);
    }
    if (!res.ok) throw new HostError("unavailable", `下载插件包失败:HTTP ${res.status}`);
    if (res.url && !res.url.startsWith("https://")) throw new HostError("forbidden", "下载被转到了非 https 地址,不安装");
    const tooBig = () => new HostError("invalid_params", `插件包超过 ${max} 字节上限`);
    if (Number(res.headers.get("content-length") ?? 0) > max) throw tooBig();
    const chunks: Buffer[] = [];
    let total = 0;
    const reader = res.body?.getReader();
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > max) {
          await reader.cancel().catch(() => {});
          throw tooBig();
        }
        chunks.push(Buffer.from(value));
      }
    }
    return Buffer.concat(chunks);
  }
  private installFrom(source: Exclude<InstallSource, { kind: "url" }> | { kind: "url"; dir: string; origin: string }, granted: string[]): PluginView {
    let dir: string;
    let origin: string;
    if (source.kind === "marketplace") {
      const e = this.catalog().find((x) => x.id === source.id);
      if (!e) throw new HostError("not_found", `市场里没有 ${source.id}`);
      if (source.version && source.version !== e.manifest.version) throw new HostError("not_found", `市场里 ${source.id} 只有 ${e.manifest.version}`);
      dir = e.dir;
      origin = source.id;
    } else if (source.kind === "local-path") {
      dir = path.resolve(source.path);
      if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new HostError("invalid_params", `${dir} 不是目录`);
      origin = dir;
    } else {
      dir = source.dir;
      origin = source.origin;
    }
    const m = readManifest(dir);
    if (one(this.d.db, "SELECT 1 FROM gg_plugins WHERE id = ?", m.id)) throw new HostError("conflict", `插件 ${m.id} 已安装,要换版本请用更新`);
    const missing = m.permissions.map((p) => p.key).filter((k) => !granted.includes(k));
    if (missing.length) throw new HostError("forbidden", `安装需要你同意这些权限:${missing.join("、")}`, { missing });
    const target = this.copyIn(m, dir);
    run(
      this.d.db,
      "INSERT INTO gg_plugins (id, version, source, origin, dir, enabled, status, error, manifest, config, granted, installed_at) VALUES (?, ?, ?, ?, ?, 1, 'ready', NULL, ?, NULL, ?, ?)",
      m.id,
      m.version,
      source.kind,
      origin,
      target,
      JSON.stringify(m),
      JSON.stringify(m.permissions.map((p) => p.key)),
      this.d.now(),
    );
    const v = this.get(m.id);
    this.d.emit(v);
    this.d.commandsChanged();
    return v;
  }
  private copyIn(m: Manifest, from: string): string {
    const target = path.join(this.d.dataDir, "plugins", m.id, m.version);
    rmSync(target, { recursive: true, force: true });
    mkdirSync(path.dirname(target), { recursive: true });
    cpSync(from, target, { recursive: true, dereference: false, filter: (src) => !src.split(path.sep).includes("node_modules") });
    return target;
  }
  setEnabled(id: string, enabled: boolean): PluginView {
    this.row(id);
    run(this.d.db, "UPDATE gg_plugins SET enabled = ? WHERE id = ?", enabled ? 1 : 0, id);
    if (!enabled) this.d.runtime.stop(id);
    const v = this.get(id);
    this.d.emit(v);
    this.d.commandsChanged();
    return v;
  }
  configure(id: string, config: unknown): PluginView {
    const r = this.row(id);
    const m = JSON.parse(r.manifest) as Manifest;
    if (!m.configSchema) throw new HostError("invalid_params", `插件 ${id} 没有可配置项`);
    run(this.d.db, "UPDATE gg_plugins SET config = ? WHERE id = ?", JSON.stringify(config), id);
    // 新配置下次调用时以新进程生效(init 只在启动时跑一次)
    this.d.runtime.stop(id);
    const v = this.get(id);
    this.d.emit(v);
    return v;
  }
  /** 更新到市场里的新版本;新版本多要的权限必须重新同意(不给就拒)。 */
  update(id: string, version: string | undefined, granted: string[] | undefined): PluginView {
    const r = this.row(id);
    if (r.source !== "marketplace") throw new HostError("invalid_params", "只有从市场装的插件能在线更新;本地目录请卸载后重装");
    const e = this.catalog().find((x) => x.id === id);
    if (!e) throw new HostError("not_found", `市场里已没有 ${id}`);
    if (version && version !== e.manifest.version) throw new HostError("not_found", `市场里 ${id} 只有 ${e.manifest.version}`);
    if (cmp(e.manifest.version, r.version) <= 0) throw new HostError("conflict", `已是最新版本 ${r.version}`);
    const had = JSON.parse(r.granted) as string[];
    const all_ = [...had, ...(granted ?? [])];
    const missing = e.manifest.permissions.map((p) => p.key).filter((k) => !all_.includes(k));
    if (missing.length) throw new HostError("forbidden", `新版本需要你同意新增权限:${missing.join("、")}`, { missing });
    this.d.runtime.stop(id);
    const target = this.copyIn(e.manifest, e.dir);
    run(this.d.db, "UPDATE gg_plugins SET version = ?, dir = ?, manifest = ?, granted = ? WHERE id = ?", e.manifest.version, target, JSON.stringify(e.manifest), JSON.stringify(e.manifest.permissions.map((p) => p.key)), id);
    const v = this.get(id);
    this.d.emit(v);
    this.d.commandsChanged();
    return v;
  }
  uninstall(id: string) {
    this.row(id);
    this.d.runtime.forget(id);
    run(this.d.db, "DELETE FROM gg_plugins WHERE id = ?", id);
    rmSync(path.join(this.d.dataDir, "plugins", id), { recursive: true, force: true });
    rmSync(path.join(this.d.dataDir, "plugin-data", id), { recursive: true, force: true });
    this.d.emit({ removed: id });
    this.d.commandsChanged();
  }
  /** 插件进程 pid(没在跑为 null)。 */
  pid(id: string) {
    return this.d.runtime.pid(id);
  }
  /** 调用前检查:已安装、已启用、有 entry、清单声明了这个类型。 */
  private target(id: string, kind: "data-source" | "outbound-channel"): PluginTarget {
    const r = this.row(id);
    if (!r.enabled) throw new HostError("conflict", `插件 ${id} 已停用`);
    const m = JSON.parse(r.manifest) as Manifest;
    if (!m.entry) throw new HostError("unavailable", `插件 ${id} 没有可执行代码(清单没有 entry)`);
    if (!m.kinds.includes(kind)) throw new HostError("invalid_params", `插件 ${id} 不是${kind === "data-source" ? "数据源" : "输出渠道"}`);
    return { id, dir: r.dir, entry: m.entry, dataDir: path.join(this.d.dataDir, "plugin-data", id), config: r.config ? (JSON.parse(r.config) as unknown) : null, kinds: m.kinds };
  }
  /** 在隔离进程里拉数据源;外部事件经内核盖章为不可信。超出合同长度的事件记进 rejected,不截断。 */
  async pull(id: string, sourceId?: string) {
    const out = await this.d.runtime.pull(this.target(id, "data-source"), sourceId);
    const rejected = [...out.rejected];
    const events = out.events.filter((e, i) => {
      const tooLong = e.content.length > 100_000 || e.author.length > 2000 || e.origin.source.length > 4096 || e.origin.nativeId.length > 4096 || e.sourceVersion.length > 4096 || e.attachments.length > 100;
      if (tooLong) rejected.push({ sourceId: e.origin.source, index: i, reason: `事件 ${e.origin.nativeId.slice(0, 200)} 的字段超过合同长度上限` });
      return !tooLong;
    });
    return {
      sources: out.sources,
      events: events.map((e) => ({ ...e, origin: { ...e.origin }, attachments: e.attachments.map((a) => ({ ...a })) })),
      rejected,
      failures: out.failures,
    };
  }
  /** 经输出渠道外发:同一 actionId 由内核按 B1/B2 记账,已确认复用回执,结果未知时 B2 不再发。 */
  async send(id: string, actionId: string, payload: string) {
    const r = await this.d.runtime.send(this.target(id, "outbound-channel"), actionId, payload);
    if (r.ok) return { state: r.state, receiptId: r.receipt.receiptId, deduplicated: r.deduplicated, reason: null, detail: null };
    return { state: r.state, receiptId: null, deduplicated: false, reason: r.reason, detail: r.detail.slice(0, 2000) };
  }
  close() {
    this.d.runtime.close();
  }
  /** 已启用插件声明的 slash 命令。 */
  commands(): SlashCommand[] {
    const out: SlashCommand[] = [];
    for (const r of all<Row>(this.d.db, "SELECT * FROM gg_plugins WHERE enabled = 1 ORDER BY id")) {
      const m = JSON.parse(r.manifest) as Manifest;
      for (const c of m.commands ?? []) out.push({ name: c.name, description: c.description, args: c.args, source: "plugin", pluginId: r.id, targetContactId: null });
    }
    return out;
  }
}
