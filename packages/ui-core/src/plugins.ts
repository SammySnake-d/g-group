// 插件:清单(manifest)模型与校验、安装生命周期、市场列表的搜索 / 筛选 / 排序。
// 纯函数、零依赖、所有类型都是可序列化的纯数据;渲染层现在用演示数据,将来后端的
// plugins.catalog / plugins.install / plugins.uninstall / plugins.setEnabled 也按这些类型收发。

// ---------------------------------------------------------------- 清单模型

export const PLUGIN_CATEGORIES = Object.freeze(["source", "outbound", "ui", "command"] as const);
export type PluginCategory = (typeof PLUGIN_CATEGORIES)[number];
export const CATEGORY_LABEL: Readonly<Record<PluginCategory, string>> = Object.freeze({
  source: "取数据",
  outbound: "发出去",
  ui: "面板",
  command: "命令",
});
export const CATEGORY_DESC: Readonly<Record<PluginCategory, string>> = Object.freeze({
  source: "让助手读到外面的东西:别的聊天软件、网页、订阅",
  outbound: "让助手往外发:邮件、请求、别的群",
  ui: "在聊天旁边多一块面板",
  command: "在输入框里用 / 唤起的一条能力",
});

export const RISK_LEVELS = Object.freeze(["low", "medium", "high"] as const);
export type RiskLevel = (typeof RISK_LEVELS)[number];
export const RISK_LABEL: Readonly<Record<RiskLevel, string>> = Object.freeze({ low: "低", medium: "中", high: "高" });

/** 一项权限:范围(机器可读)、具体说明(给人看)、风险级别 */
export interface PluginPermission {
  scope: string;
  detail: string;
  risk: RiskLevel;
}
export interface CommandArg {
  name: string;
  desc: string;
  required: boolean;
}
/** 插件贡献的斜杠命令:name 不带 /,只许小写字母、数字和 -,2–32 位 */
export interface PluginCommand {
  name: string;
  title: string;
  desc: string;
  args: CommandArg[];
}
export interface PluginPanel {
  id: string;
  title: string;
  desc: string;
}
export interface PluginEvent {
  name: string;
  desc: string;
}
export interface PluginContributes {
  commands: PluginCommand[];
  panels: PluginPanel[];
  events: PluginEvent[];
}
export interface ChangelogEntry {
  version: string;
  /** YYYY-MM-DD */
  date: string;
  notes: string[];
}
/** 图标:一个字 + 品牌色(数据,不是界面主题色) */
export interface PluginIcon {
  letter: string;
  color: string;
}
export interface PluginManifest {
  id: string;
  name: string;
  publisher: string;
  version: string;
  category: PluginCategory;
  /** 一句话简介 */
  summary: string;
  /** 详细说明 */
  description: string;
  icon: PluginIcon;
  permissions: PluginPermission[];
  contributes: PluginContributes;
  /** 新的在前 */
  changelog: ChangelogEntry[];
}

// ---------------------------------------------------------------- 版本号(semver 2.0)

export interface Semver {
  major: number;
  minor: number;
  patch: number;
  pre: string[];
}
const NUM = "0|[1-9]\\d*";
const PRE_ID = `(?:${NUM}|\\d*[a-zA-Z-][0-9a-zA-Z-]*)`;
const SEMVER_RE = new RegExp(`^(${NUM})\\.(${NUM})\\.(${NUM})(?:-(${PRE_ID}(?:\\.${PRE_ID})*))?(?:\\+[0-9a-zA-Z-]+(?:\\.[0-9a-zA-Z-]+)*)?$`);

/** 解析 主.次.修订[-预发布][+构建];不合法返回 undefined。构建元数据不参与比较,直接丢掉 */
export function parseSemver(v: string): Semver | undefined {
  const m = SEMVER_RE.exec(v);
  if (!m) return undefined;
  const nums = [m[1], m[2], m[3]].map(Number);
  if (nums.some((n) => !Number.isSafeInteger(n))) return undefined;
  return { major: nums[0]!, minor: nums[1]!, patch: nums[2]!, pre: m[4] ? m[4].split(".") : [] };
}

export function isValidSemver(v: unknown): boolean {
  return typeof v === "string" && parseSemver(v) !== undefined;
}

const cmpNum = (a: number, b: number) => (a < b ? -1 : a > b ? 1 : 0);
function cmpPre(a: string[], b: string[]): -1 | 0 | 1 {
  // 没有预发布标识的版本更高:1.0.0 > 1.0.0-rc.1
  if (a.length === 0 || b.length === 0) return a.length === b.length ? 0 : a.length === 0 ? 1 : -1;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i], y = b[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
    if (xn && yn) {
      const c = cmpNum(Number(x), Number(y));
      if (c !== 0) return c;
    } else if (xn !== yn) return xn ? -1 : 1; // 纯数字标识比字母数字标识低
    else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** a 比 b 新返回 1,一样返回 0,旧返回 -1。任何一边不合法就抛错(调用方先校验) */
export function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const x = parseSemver(a), y = parseSemver(b);
  if (!x) throw new Error(`版本号「${a}」不合法`);
  if (!y) throw new Error(`版本号「${b}」不合法`);
  return cmpNum(x.major, y.major) || cmpNum(x.minor, y.minor) || cmpNum(x.patch, y.patch) || cmpPre(x.pre, y.pre);
}

// ---------------------------------------------------------------- 清单校验

export type ManifestCheck = { ok: true; manifest: PluginManifest } | { ok: false; errors: string[] };

export const PLUGIN_ID_RE = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
export const COMMAND_NAME_RE = /^[a-z0-9-]{2,32}$/;
const COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const MANIFEST_LIMITS = Object.freeze({ name: 40, publisher: 40, summary: 80, description: 4000, permissions: 30, commands: 30 });
const DEFAULT_ICON_COLOR = "#71717a";

const FIELD: Record<string, string> = {
  id: "插件 id",
  name: "名称",
  publisher: "发布者",
  version: "版本号",
  category: "类别",
  summary: "一句话简介",
  description: "详细说明",
  permissions: "权限列表",
  scope: "范围",
  detail: "具体说明",
  risk: "风险级别",
  title: "标题",
  desc: "说明",
  date: "日期",
  notes: "改动",
};
const missing = (where: string, k: string) => `${where}缺少字段 ${k}(${FIELD[k] ?? k})`;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const len = (s: string) => [...s].length;

/** 校验一份外来清单(粘贴的 JSON、后端返回的数据)。全部问题一次列出,中文说明;通过时返回补齐默认值的清单 */
export function validateManifest(input: unknown): ManifestCheck {
  if (!isObj(input)) return { ok: false, errors: ["清单必须是一个 JSON 对象"] };
  const errors: string[] = [];
  const text = (o: Record<string, unknown>, k: string, where: string, max?: number) => {
    const v = o[k];
    if (v === undefined || v === null) {
      errors.push(missing(where, k));
      return "";
    }
    if (typeof v !== "string") {
      errors.push(`${where}${FIELD[k] ?? k}(${k})必须是文字`);
      return "";
    }
    if (v.trim() === "") {
      errors.push(`${where}${FIELD[k] ?? k}(${k})不能为空`);
      return "";
    }
    if (max !== undefined && len(v) > max) errors.push(`${where}${FIELD[k] ?? k}太长:最多 ${max} 字,现在 ${len(v)} 字`);
    return v.trim();
  };
  const list = (o: Record<string, unknown>, k: string, where: string, required: boolean): unknown[] => {
    const v = o[k];
    if (v === undefined || v === null) {
      if (required) errors.push(missing(where, k));
      return [];
    }
    if (!Array.isArray(v)) {
      errors.push(`${where}${FIELD[k] ?? k}(${k})必须是数组`);
      return [];
    }
    return v;
  };

  const id = text(input, "id", "");
  if (id && (!PLUGIN_ID_RE.test(id) || id.length < 3 || id.length > 64)) errors.push(`插件 id「${id}」不合法:只能用小写字母、数字、点和 -,3–64 位,比如 g-group.feishu`);
  const name = text(input, "name", "", MANIFEST_LIMITS.name);
  const publisher = text(input, "publisher", "", MANIFEST_LIMITS.publisher);
  const version = text(input, "version", "");
  if (version && !isValidSemver(version)) errors.push(`版本号「${version}」不合法:要写成 主版本.次版本.修订号,比如 1.4.2`);
  const category = text(input, "category", "");
  if (category && !(PLUGIN_CATEGORIES as readonly string[]).includes(category))
    errors.push(`类别「${category}」不合法:只能是 ${PLUGIN_CATEGORIES.map((c) => `${c}(${CATEGORY_LABEL[c]})`).join(" / ")}`);
  const summary = text(input, "summary", "", MANIFEST_LIMITS.summary);
  const description = text(input, "description", "", MANIFEST_LIMITS.description);

  let icon: PluginIcon = { letter: name ? [...name][0]! : "?", color: DEFAULT_ICON_COLOR };
  if (input.icon !== undefined) {
    if (!isObj(input.icon)) errors.push("图标(icon)必须是对象:{ letter, color }");
    else {
      const letter = typeof input.icon.letter === "string" && input.icon.letter.trim() ? input.icon.letter.trim() : icon.letter;
      const color = input.icon.color;
      if (color !== undefined && (typeof color !== "string" || !COLOR_RE.test(color))) errors.push(`图标颜色「${String(color)}」不合法:要写成 #RRGGBB`);
      if (len(letter) > 2) errors.push(`图标文字「${letter}」太长:最多 2 个字`);
      icon = { letter, color: typeof color === "string" && COLOR_RE.test(color) ? color : DEFAULT_ICON_COLOR };
    }
  }

  const permissions: PluginPermission[] = [];
  const rawPerms = list(input, "permissions", "", true);
  if (rawPerms.length > MANIFEST_LIMITS.permissions) errors.push(`权限太多:最多 ${MANIFEST_LIMITS.permissions} 项`);
  const scopes = new Set<string>();
  rawPerms.forEach((p, i) => {
    const where = `权限第 ${i + 1} 项`;
    if (!isObj(p)) {
      errors.push(`${where}必须是对象:{ scope, detail, risk }`);
      return;
    }
    const scope = text(p, "scope", where);
    const detail = text(p, "detail", where);
    const risk = text(p, "risk", where);
    if (risk && !(RISK_LEVELS as readonly string[]).includes(risk))
      errors.push(`${where}${scope ? `「${scope}」` : ""}的风险级别「${risk}」不合法:只能是 ${RISK_LEVELS.map((r) => `${r}(${RISK_LABEL[r]})`).join(" / ")}`);
    if (scope && scopes.has(scope)) errors.push(`权限「${scope}」重复了`);
    if (scope) scopes.add(scope);
    if (scope && detail && (RISK_LEVELS as readonly string[]).includes(risk)) permissions.push({ scope, detail, risk: risk as RiskLevel });
  });

  const contributes: PluginContributes = { commands: [], panels: [], events: [] };
  if (input.contributes !== undefined && !isObj(input.contributes)) errors.push("提供的能力(contributes)必须是对象:{ commands, panels, events }");
  const c = isObj(input.contributes) ? input.contributes : {};
  const rawCmds = list(c, "commands", "", false);
  if (rawCmds.length > MANIFEST_LIMITS.commands) errors.push(`命令太多:最多 ${MANIFEST_LIMITS.commands} 条`);
  const names = new Set<string>();
  rawCmds.forEach((x, i) => {
    const where = `命令第 ${i + 1} 条`;
    if (!isObj(x)) {
      errors.push(`${where}必须是对象:{ name, title, desc, args }`);
      return;
    }
    const n = text(x, "name", where);
    if (n && !COMMAND_NAME_RE.test(n)) errors.push(`命令名「/${n}」不合法:只能用小写字母、数字和 -,2–32 位`);
    else if (n && names.has(n)) errors.push(`命令 /${n} 重复了`);
    if (n) names.add(n);
    const title = text(x, "title", where);
    const desc = text(x, "desc", where);
    const args: CommandArg[] = [];
    list(x, "args", where, false).forEach((a, j) => {
      const aw = `${where}的参数第 ${j + 1} 个`;
      if (!isObj(a)) {
        errors.push(`${aw}必须是对象:{ name, desc, required }`);
        return;
      }
      const an = text(a, "name", aw);
      const ad = text(a, "desc", aw);
      if (a.required !== undefined && typeof a.required !== "boolean") errors.push(`${aw}的 required 必须是 true 或 false`);
      if (an && ad) args.push({ name: an, desc: ad, required: a.required === true });
    });
    if (n && COMMAND_NAME_RE.test(n) && title && desc) contributes.commands.push({ name: n, title, desc, args });
  });
  list(c, "panels", "", false).forEach((x, i) => {
    const where = `面板第 ${i + 1} 块`;
    if (!isObj(x)) {
      errors.push(`${where}必须是对象:{ id, title, desc }`);
      return;
    }
    const pid = text(x, "id", where), title = text(x, "title", where);
    const desc = typeof x.desc === "string" ? x.desc.trim() : "";
    if (pid && title) contributes.panels.push({ id: pid, title, desc });
  });
  list(c, "events", "", false).forEach((x, i) => {
    const where = `事件第 ${i + 1} 个`;
    if (!isObj(x)) {
      errors.push(`${where}必须是对象:{ name, desc }`);
      return;
    }
    const en = text(x, "name", where);
    const desc = typeof x.desc === "string" ? x.desc.trim() : "";
    if (en) contributes.events.push({ name: en, desc });
  });

  const changelog: ChangelogEntry[] = [];
  list(input, "changelog", "", false).forEach((x, i) => {
    const where = `更新日志第 ${i + 1} 条`;
    if (!isObj(x)) {
      errors.push(`${where}必须是对象:{ version, date, notes }`);
      return;
    }
    const v = text(x, "version", where);
    if (v && !isValidSemver(v)) errors.push(`${where}的版本号「${v}」不合法:要写成 主版本.次版本.修订号`);
    const date = text(x, "date", where);
    if (date && !DATE_RE.test(date)) errors.push(`${where}的日期「${date}」不合法:要写成 YYYY-MM-DD`);
    const notes = list(x, "notes", where, true).filter((n): n is string => typeof n === "string" && n.trim() !== "");
    if (v && isValidSemver(v) && date && DATE_RE.test(date)) changelog.push({ version: v, date, notes });
  });

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    manifest: { id, name, publisher, version, category: category as PluginCategory, summary, description, icon, permissions, contributes, changelog },
  };
}

/** JSON.parse 的英文报错 → 中文,尽量带上行列 */
function jsonErrorText(msg: string) {
  const lc = /line (\d+) column (\d+)/.exec(msg);
  if (lc) return `不是合法的 JSON:第 ${lc[1]} 行第 ${lc[2]} 列附近有错`;
  const tok = /Unexpected token '(.+?)'/.exec(msg);
  if (tok) return `不是合法的 JSON:有不该出现的「${tok[1]}」`;
  if (/end of (JSON|data)/i.test(msg)) return "不是合法的 JSON:内容不完整,可能少了括号或引号";
  return "不是合法的 JSON";
}

/** 粘贴进来的一段文字 → 先当 JSON 解析,再校验 */
export function parseManifestText(raw: string): ManifestCheck {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    return { ok: false, errors: [jsonErrorText(e instanceof Error ? e.message : "")] };
  }
  return validateManifest(data);
}

export type InstallSource =
  | { kind: "empty" }
  | { kind: "manifest"; check: ManifestCheck }
  | { kind: "url"; url: string }
  | { kind: "invalid"; error: string };

/** 「从文件或地址安装」输入框:以 { 开头当清单 JSON;否则当地址,只接受 https(本机调试可用 http://localhost) */
export function readInstallSource(raw: string): InstallSource {
  const s = raw.trim();
  if (s === "") return { kind: "empty" };
  if (s.startsWith("{") || s.startsWith("[")) return { kind: "manifest", check: parseManifestText(s) };
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return { kind: "invalid", error: "看不出是清单还是地址:粘贴清单 JSON(以 { 开头),或者 https:// 开头的地址" };
  }
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  if (u.protocol === "https:" || (u.protocol === "http:" && local)) return { kind: "url", url: u.href };
  return { kind: "invalid", error: `只接受 https 地址,现在是「${u.protocol.replace(/:$/, "")}」` };
}

// ---------------------------------------------------------------- 权限比较

const RISK_RANK = { low: 0, medium: 1, high: 2 } as const;
export interface PermissionDiff {
  /** 新版本多出来的范围 */
  added: PluginPermission[];
  /** 范围一样但风险级别升高 */
  raised: PluginPermission[];
  /** 新版本不再要的范围 */
  removed: PluginPermission[];
}
export function permissionDiff(granted: readonly PluginPermission[], next: readonly PluginPermission[]): PermissionDiff {
  const old = new Map(granted.map((p) => [p.scope, p]));
  const now = new Set(next.map((p) => p.scope));
  const added: PluginPermission[] = [], raised: PluginPermission[] = [];
  for (const p of next) {
    const was = old.get(p.scope);
    if (!was) added.push(p);
    else if (RISK_RANK[p.risk] > RISK_RANK[was.risk]) raised.push(p);
  }
  return { added, raised, removed: granted.filter((p) => !now.has(p.scope)) };
}
/** 要重新问你的:新增的 + 风险升高的 */
export function permissionsToConsent(granted: readonly PluginPermission[], next: readonly PluginPermission[]): PluginPermission[] {
  const d = permissionDiff(granted, next);
  return [...d.added, ...d.raised];
}

// ---------------------------------------------------------------- 安装生命周期

export const INSTALL_PHASES = Object.freeze(["not_installed", "installing", "enabled", "disabled", "uninstalling"] as const);
export type InstallPhase = (typeof INSTALL_PHASES)[number];
export const PHASE_LABEL: Readonly<Record<InstallPhase, string>> = Object.freeze({
  not_installed: "未安装",
  installing: "安装中",
  enabled: "已启用",
  disabled: "已停用",
  uninstalling: "卸载中",
});

/** 一个插件在这台机器上的安装状态。装了才有 manifest(已装版本的清单) */
export interface PluginInstall {
  id: string;
  phase: InstallPhase;
  manifest: PluginManifest | null;
  /** 正在装的版本 */
  pending: PluginManifest | null;
  /** 你同意过的权限(快照) */
  granted: PluginPermission[];
  /** 挂在哪些聊天(会话 id) */
  convs: string[];
  /** 谁能调用(助手 id 白名单) */
  callers: string[];
}

export type PluginAction =
  | { type: "install"; manifest: PluginManifest; consent: readonly string[] }
  | { type: "install_done" }
  | { type: "install_failed" }
  | { type: "enable" }
  | { type: "disable" }
  | { type: "update"; manifest: PluginManifest; consent: readonly string[] }
  | { type: "uninstall" }
  | { type: "uninstall_done" }
  | { type: "attach"; conv: string }
  | { type: "detach"; conv: string }
  | { type: "allow"; caller: string }
  | { type: "disallow"; caller: string };

export type PluginResult<S extends PluginInstall = PluginInstall> =
  | { ok: true; state: S }
  | { ok: false; state: S; error: string; needsConsent: PluginPermission[] };

const ACTION_LABEL: Record<PluginAction["type"], string> = {
  install: "安装",
  install_done: "完成安装",
  install_failed: "标记安装失败",
  enable: "启用",
  disable: "停用",
  update: "更新",
  uninstall: "卸载",
  uninstall_done: "完成卸载",
  attach: "挂到聊天",
  detach: "从聊天摘下",
  allow: "加调用者",
  disallow: "移除调用者",
};
/** 每个动作允许从哪些状态出发 */
const FROM: Record<PluginAction["type"], readonly InstallPhase[]> = {
  install: ["not_installed"],
  install_done: ["installing"],
  install_failed: ["installing"],
  enable: ["disabled"],
  disable: ["enabled"],
  update: ["enabled", "disabled"],
  uninstall: ["enabled", "disabled"],
  uninstall_done: ["uninstalling"],
  attach: ["enabled", "disabled"],
  detach: ["enabled", "disabled"],
  allow: ["enabled", "disabled"],
  disallow: ["enabled", "disabled"],
};

export function notInstalled(id: string): PluginInstall {
  return { id, phase: "not_installed", manifest: null, pending: null, granted: [], convs: [], callers: [] };
}
/** 演示数据 / 后端回放用:直接构造一个已装好的状态(权限视为已同意) */
export function seedInstalled(manifest: PluginManifest, opt: { enabled: boolean; convs: readonly string[]; callers: readonly string[] }): PluginInstall {
  return { id: manifest.id, phase: opt.enabled ? "enabled" : "disabled", manifest, pending: null, granted: manifest.permissions.map((p) => ({ ...p })), convs: [...new Set(opt.convs)], callers: [...new Set(opt.callers)] };
}

export const isInstalled = (s: PluginInstall) => s.phase === "enabled" || s.phase === "disabled";
export const pluginName = (s: PluginInstall) => s.manifest?.name ?? s.pending?.name ?? s.id;

/**
 * 安装生命周期:未安装 → 安装中 → 已启用 ⇄ 已停用 → 卸载中 → 未安装。
 * 非法转移返回 ok:false 和原状态(同一个对象,不改);需要你同意权限时 needsConsent 列出差集。
 */
export function pluginReducer<S extends PluginInstall>(s: S, a: PluginAction): PluginResult<S> {
  const fail = (error: string, needsConsent: PluginPermission[] = []): PluginResult<S> => ({ ok: false, state: s, error, needsConsent });
  const ok = (patch: Partial<PluginInstall>): PluginResult<S> => ({ ok: true, state: { ...s, ...patch } });
  if (!FROM[a.type].includes(s.phase)) return fail(`「${pluginName(s)}」现在是「${PHASE_LABEL[s.phase]}」,不能${ACTION_LABEL[a.type]}`);
  switch (a.type) {
    case "install": {
      if (a.manifest.id !== s.id) return fail(`清单 id「${a.manifest.id}」和要装的插件「${s.id}」不一致`);
      const agreed = new Set(a.consent);
      const left = a.manifest.permissions.filter((p) => !agreed.has(p.scope));
      if (left.length) return fail(`还有 ${left.length} 项权限没同意:${left.map((p) => `「${p.detail}」`).join("")}`, left);
      return ok({ phase: "installing", pending: a.manifest, manifest: null, granted: a.manifest.permissions.map((p) => ({ ...p })), convs: [], callers: [] });
    }
    case "install_done":
      return ok({ phase: "enabled", manifest: s.pending, pending: null });
    case "install_failed":
      return ok({ phase: "not_installed", manifest: null, pending: null, granted: [], convs: [], callers: [] });
    case "enable":
      return ok({ phase: "enabled" });
    case "disable":
      return ok({ phase: "disabled" });
    case "update": {
      const cur = s.manifest;
      if (!cur) return fail(`「${pluginName(s)}」没有已装版本的清单,不能更新`);
      if (a.manifest.id !== s.id) return fail(`清单 id「${a.manifest.id}」和要更新的插件「${s.id}」不一致`);
      const c = compareSemver(a.manifest.version, cur.version);
      if (c === 0) return fail(`已经是 v${cur.version},不用更新`);
      if (c < 0) return fail(`v${a.manifest.version} 比已装的 v${cur.version} 旧,不能降级`);
      const agreed = new Set(a.consent);
      const need = permissionsToConsent(s.granted, a.manifest.permissions).filter((p) => !agreed.has(p.scope));
      if (need.length) return fail(`v${a.manifest.version} 多要了 ${need.length} 项权限,要你重新同意`, need);
      return ok({ manifest: a.manifest, granted: a.manifest.permissions.map((p) => ({ ...p })) });
    }
    case "uninstall":
      return ok({ phase: "uninstalling" });
    case "uninstall_done":
      return ok({ phase: "not_installed", manifest: null, pending: null, granted: [], convs: [], callers: [] });
    case "attach":
      if (!a.conv) return fail("没有指定聊天");
      if (s.convs.includes(a.conv)) return fail(`「${pluginName(s)}」已经挂在这个聊天上了`);
      return ok({ convs: [...s.convs, a.conv] });
    case "detach":
      if (!s.convs.includes(a.conv)) return fail(`「${pluginName(s)}」没有挂在这个聊天上`);
      return ok({ convs: s.convs.filter((x) => x !== a.conv) });
    case "allow":
      if (!a.caller) return fail("没有指定助手");
      if (s.callers.includes(a.caller)) return fail("它已经能调用了");
      return ok({ callers: [...s.callers, a.caller] });
    case "disallow":
      if (!s.callers.includes(a.caller)) return fail("它本来就不能调用");
      return ok({ callers: s.callers.filter((x) => x !== a.caller) });
  }
}

/** 四道关都过了才真能用:已启用、挂在这个聊天、这个助手在白名单里 */
export function canInvoke(s: PluginInstall, caller: string, conv: string): boolean {
  return s.phase === "enabled" && s.convs.includes(conv) && s.callers.includes(caller);
}

/** 已装版本落后于市场上的最新版本 */
export function hasUpdate(s: PluginInstall | null | undefined, latest: PluginManifest | null | undefined) {
  if (!s || !isInstalled(s) || !s.manifest || !latest) return false;
  return compareSemver(latest.version, s.manifest.version) > 0;
}

/** 从已装版本到最新版本之间的更新日志(不含已装版本本身),新的在前 */
export function changesSince(installed: string, latest: PluginManifest): ChangelogEntry[] {
  return latest.changelog.filter((e) => compareSemver(e.version, installed) > 0);
}

// ---------------------------------------------------------------- 命令

export interface ContributedCommand {
  plugin: string;
  pluginName: string;
  command: PluginCommand;
}
/** 已启用插件贡献的斜杠命令;给了 conv 就只算挂在这个聊天上的。按命令名排序 */
export function pluginCommands(installs: readonly PluginInstall[], conv?: string): ContributedCommand[] {
  const out: ContributedCommand[] = [];
  for (const s of installs) {
    if (s.phase !== "enabled" || !s.manifest) continue;
    if (conv !== undefined && !s.convs.includes(conv)) continue;
    for (const command of s.manifest.contributes.commands) out.push({ plugin: s.id, pluginName: s.manifest.name, command });
  }
  return out.sort((a, b) => (a.command.name < b.command.name ? -1 : a.command.name > b.command.name ? 1 : 0));
}
/** /feishu <群名> [条数] */
export function commandUsage(c: PluginCommand): string {
  return [`/${c.name}`, ...c.args.map((a) => (a.required ? `<${a.name}>` : `[${a.name}]`))].join(" ");
}

/** 已装、但还没挂到这个聊天的插件(群资料·插件·添加) */
export function attachable(installs: readonly PluginInstall[], conv: string): PluginInstall[] {
  return installs.filter((s) => isInstalled(s) && !s.convs.includes(conv));
}

// ---------------------------------------------------------------- 市场列表

export type MarketFilter = "all" | "installed" | "updates";
export type MarketSort = "featured" | "name" | "updated";
export interface MarketQuery {
  text: string;
  category: PluginCategory | "all";
  filter: MarketFilter;
  sort: MarketSort;
}
export type MatchField = "name" | "summary" | "command";
export interface MarketItem {
  /** 市场上的最新清单(没上架的本地插件用已装版本的清单) */
  manifest: PluginManifest;
  install: PluginInstall | null;
  phase: InstallPhase;
  installedVersion: string | null;
  hasUpdate: boolean;
  /** 搜索命中的位置;没搜索时为空 */
  matched: MatchField[];
}

const norm = (s: string) => s.trim().toLowerCase();
/** 按名称、简介、命令名搜;命令名可带也可不带 / */
export function matchFields(m: PluginManifest, text: string): MatchField[] {
  const q = norm(text);
  if (!q) return [];
  const out: MatchField[] = [];
  if (norm(m.name).includes(q)) out.push("name");
  if (norm(m.summary).includes(q)) out.push("summary");
  const cq = q.replace(/^\//, "");
  if (cq && m.contributes.commands.some((c) => c.name.includes(cq))) out.push("command");
  return out;
}
const SCORE: Record<MatchField, number> = { name: 4, command: 2, summary: 1 };
const latestDate = (m: PluginManifest) => m.changelog.map((e) => e.date).sort().at(-1) ?? "";

/** 市场列表:目录(最新版本)+ 本机安装状态 → 搜索、按类别 / 已安装 / 有更新筛选、排序 */
export function marketList(catalog: readonly PluginManifest[], installs: readonly PluginInstall[], q: MarketQuery): MarketItem[] {
  const byId = new Map(installs.map((s) => [s.id, s]));
  const listed = new Set(catalog.map((m) => m.id));
  // 不在目录里但装着的(从文件装的、已下架的)也要能看到
  const local = installs.filter((s) => !listed.has(s.id) && isInstalled(s) && s.manifest).map((s) => s.manifest!);
  const items: (MarketItem & { order: number; score: number })[] = [];
  [...catalog, ...local].forEach((m, order) => {
    const install = byId.get(m.id) ?? null;
    const matched = matchFields(m, q.text);
    if (norm(q.text) && matched.length === 0) return;
    if (q.category !== "all" && m.category !== q.category) return;
    const phase = install?.phase ?? "not_installed";
    const upd = hasUpdate(install, m);
    if (q.filter === "installed" && !(install && isInstalled(install))) return;
    if (q.filter === "updates" && !upd) return;
    const score = matched.reduce((n, f) => n + SCORE[f], 0);
    items.push({ manifest: m, install, phase, installedVersion: install?.manifest?.version ?? null, hasUpdate: upd, matched, order, score });
  });
  const byName = (a: MarketItem, b: MarketItem) => a.manifest.name.localeCompare(b.manifest.name, "zh-Hans-CN");
  items.sort((a, b) => {
    if (q.sort === "name") return byName(a, b);
    if (q.sort === "updated") return latestDate(b.manifest).localeCompare(latestDate(a.manifest)) || byName(a, b);
    return b.score - a.score || a.order - b.order; // featured:有搜索词时先按命中程度,再按目录顺序
  });
  return items.map(({ order: _o, score: _s, ...it }) => it);
}

export interface MarketCounts {
  all: number;
  installed: number;
  updates: number;
  byCategory: Record<PluginCategory, number>;
}
export function marketCounts(catalog: readonly PluginManifest[], installs: readonly PluginInstall[]): MarketCounts {
  const all = marketList(catalog, installs, { text: "", category: "all", filter: "all", sort: "featured" });
  const byCategory = { source: 0, outbound: 0, ui: 0, command: 0 };
  for (const it of all) byCategory[it.manifest.category]++;
  return {
    all: all.length,
    installed: all.filter((it) => it.install && isInstalled(it.install)).length,
    updates: all.filter((it) => it.hasUpdate).length,
    byCategory,
  };
}
