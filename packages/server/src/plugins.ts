// 插件:市场目录、安装、启停、配置、更新、卸载,以及插件声明的 slash 命令(用户 #719:「连插件市场和安装的入口都没有」)。
// 插件包 = 一个目录,根上有 plugin.json(清单)。市场 = 一个 catalog.json,列出可装插件与包目录。
// 安装先校验清单、核对用户勾选的权限覆盖清单声明的全部权限,再把包复制进宿主数据目录 plugins/<id>/<version>/,与来源解耦。
// 本片只管理安装态与清单(版本、权限、命令、配置);插件代码的加载执行要走进程隔离(PR #6 R9-01 范围 A 的兜底),另片接入,
// 所以这里不 import 任何插件代码。
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import type { MarketplaceEntry, PluginView, SlashCommand } from "@g-group/api-contract";
import { SlashCommand as SlashCommandSchema, arr, formatIssues, json, obj, oneOf, opt, str } from "@g-group/api-contract";
import { type Db, HostError, all, one, run } from "./db.ts";

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
    };
  }
  list(): PluginView[] {
    return all<Row>(this.d.db, "SELECT * FROM gg_plugins ORDER BY installed_at, id").map((r) => this.view(r));
  }
  get(id: string): PluginView {
    return this.view(this.row(id));
  }
  install(source: { kind: "marketplace"; id: string; version?: string } | { kind: "local-path"; path: string } | { kind: "url"; url: string }, granted: string[]): PluginView {
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
      throw new HostError("unavailable", "从 URL 安装尚未接入(需要下载与签名校验),请先用市场或本地目录");
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
    const target = this.copyIn(e.manifest, e.dir);
    run(this.d.db, "UPDATE gg_plugins SET version = ?, dir = ?, manifest = ?, granted = ? WHERE id = ?", e.manifest.version, target, JSON.stringify(e.manifest), JSON.stringify(e.manifest.permissions.map((p) => p.key)), id);
    const v = this.get(id);
    this.d.emit(v);
    this.d.commandsChanged();
    return v;
  }
  uninstall(id: string) {
    const r = this.row(id);
    run(this.d.db, "DELETE FROM gg_plugins WHERE id = ?", id);
    rmSync(path.join(this.d.dataDir, "plugins", id), { recursive: true, force: true });
    void r;
    this.d.emit({ removed: id });
    this.d.commandsChanged();
  }
  /** 插件进程 pid(没在跑为 null)。空壳:进程隔离运行时下一提交接入。 */
  pid(_id: string): number | null {
    return null;
  }
  async pull(_id: string, _sourceId?: string): Promise<never> {
    throw new HostError("unavailable", "插件运行时尚未接入");
  }
  async send(_id: string, _actionId: string, _payload: string): Promise<never> {
    throw new HostError("unavailable", "插件运行时尚未接入");
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
