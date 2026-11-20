// 这里只放纯逻辑:命令模型、光标处识别、过滤排序、选中后的文本替换、参数解析与校验。

export type SlashArgKind = "text" | "person" | "choice" | "number" | "time";

export interface SlashArg {
  name: string;
  kind: SlashArgKind;
  required: boolean;
  hint: string;
  options?: readonly string[];
  rest?: boolean;
}

export type SlashSource = "builtin" | `plugin:${string}` | `assistant:${string}`;
export type SlashScope = "group" | "dm" | "any";

export interface SlashCommand {
  name: string;
  title: string;
  desc: string;
  args: readonly SlashArg[];
  source: SlashSource;
  scope: SlashScope;
  aliases?: readonly string[];
  /** 插件命令:注册这条命令时插件的版本。执行前要和插件当前版本对得上(不能绕过版本校验) */
  version?: string;
}

/** 插件此刻的状态(宿主给):装没装、启没启用、授权在不在、挂没挂在当前会话、当前版本 */
export interface SlashPluginState {
  id: string;
  name: string;
  installed: boolean;
  enabled: boolean;
  authorized: boolean;
  attached: boolean;
  version: string;
}

/** 当前会话的情况:是群还是私聊、各插件的状态、在场的助手 */
export interface SlashWhere {
  scope: "group" | "dm";
  plugins: readonly SlashPluginState[];
  assistants: readonly string[];
}

/** 菜单里的一条:disabled 有值 = 灰显,写明为什么现在不能用 */
export interface SlashEntry {
  command: SlashCommand;
  disabled?: string;
}

export interface SlashToken {
  start: number;
  end: number;
  query: string;
}

export interface SlashArgState {
  arg: SlashArg;
  value: string | undefined;
  error: string | undefined;
}

export interface SlashInvocation {
  command: SlashCommand;
  /** 这条命令此刻不能用的原因(插件没装/停用/授权失效/没挂在本会话/版本变了);能用是 undefined */
  blocked: string | undefined;
  args: SlashArgState[];
  values: Record<string, string>;
  current: number;
  typing: boolean;
  missing: string[];
  errors: string[];
  extra: string;
  ok: boolean;
}

export interface SlashParseOptions {
  people?: readonly string[];
}

const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const KINDS: readonly string[] = ["text", "person", "choice", "number", "time"];
const SCOPES: readonly string[] = ["group", "dm", "any"];
const QUOTES: Readonly<Record<string, string>> = { '"': '"', "'": "'", "“": "”", "「": "」" };
const isSpace = (c: string | undefined) => c !== undefined && /\s/.test(c);

export function isCommandName(s: string): boolean {
  return s.length <= 32 && NAME_RE.test(s);
}

/** 拆开来源:builtin / plugin:<id> / assistant:<id>;认不出返回 undefined */
export function parseSource(src: string): { kind: "builtin" } | { kind: "plugin" | "assistant"; id: string } | undefined {
  if (src === "builtin") return { kind: "builtin" };
  const m = /^(plugin|assistant):(\S+)$/.exec(src);
  if (!m) return undefined;
  return { kind: m[1] as "plugin" | "assistant", id: m[2]! };
}

export function checkCommand(c: SlashCommand): string[] {
  const out: string[] = [];
  if (!isCommandName(c.name)) out.push(`命令名「${c.name}」只能用小写字母、数字和 -`);
  if (!c.title.trim()) out.push(`/${c.name} 缺中文名`);
  if (!parseSource(c.source)) out.push(`/${c.name} 的来源「${c.source}」认不出`);
  if (!SCOPES.includes(c.scope)) out.push(`/${c.name} 的范围「${c.scope}」认不出`);
  const names = new Set<string>([c.name]);
  for (const al of c.aliases ?? []) {
    if (!isCommandName(al)) out.push(`/${c.name} 的别名「${al}」只能用小写字母、数字和 -`);
    else if (names.has(al)) out.push(`/${c.name} 的别名「${al}」重复`);
    names.add(al);
  }
  const seen = new Set<string>();
  let optionalSeen = false;
  c.args.forEach((a, i) => {
    if (!a.name.trim()) out.push(`/${c.name} 第 ${i + 1} 个参数没有名字`);
    if (seen.has(a.name)) out.push(`/${c.name} 的参数「${a.name}」重复`);
    seen.add(a.name);
    if (!KINDS.includes(a.kind)) out.push(`/${c.name} 的参数「${a.name}」类型「${a.kind}」认不出`);
    if (a.kind === "choice" && !a.options?.length) out.push(`/${c.name} 的参数「${a.name}」是选项,但没给可选值`);
    if (a.rest && i !== c.args.length - 1) out.push(`/${c.name} 的参数「${a.name}」吞掉剩余文本,只能放最后`);
    if (a.required && optionalSeen) out.push(`/${c.name} 的必填参数「${a.name}」不能排在可选参数后面`);
    if (!a.required) optionalSeen = true;
  });
  return out;
}

/** 插件命令此刻为什么不能用;能用返回 undefined。顺序:没装 → 停用 → 授权失效 → 没挂在本会话 → 版本对不上 */
export function pluginBlock(c: SlashCommand, p: SlashPluginState): string | undefined {
  if (!p.installed) return `${p.name} 插件还没安装`;
  if (!p.enabled) return `${p.name} 插件已停用`;
  if (!p.authorized) return `${p.name} 的授权失效了,重新授权后才能用`;
  if (!p.attached) return `${p.name} 没挂在这个会话`;
  if (c.version !== undefined && c.version !== p.version) return `${p.name} 已是 ${p.version},这条命令按 ${c.version} 注册,要重新确认权限`;
  return undefined;
}

/** 这个会话的命令菜单:定义不合法、范围不对、助手不在场的不出现;插件命令都出现,但不满足条件的灰显并写明原因。
 *  同名只留一条(内置优先)。顺序:内置 → 插件 → 助手,各组内保持给定顺序。 */
export function availableCommands(all: readonly SlashCommand[], where: SlashWhere): SlashEntry[] {
  const rank = (c: SlashCommand) => (c.source === "builtin" ? 0 : c.source.startsWith("plugin:") ? 1 : 2);
  const out: SlashEntry[] = [];
  for (const c of all) {
    if (checkCommand(c).length) continue;
    if (c.scope !== "any" && c.scope !== where.scope) continue;
    const src = parseSource(c.source);
    if (src?.kind === "assistant" && !where.assistants.includes(src.id)) continue;
    if (src?.kind === "plugin") {
      const p = where.plugins.find((x) => x.id === src.id);
      if (!p) continue;
      const why = pluginBlock(c, p);
      out.push(why === undefined ? { command: c } : { command: c, disabled: why });
    } else out.push({ command: c });
  }
  const sorted = out.map((e, i) => ({ e, i })).sort((a, b) => rank(a.e.command) - rank(b.e.command) || a.i - b.i).map((x) => x.e);
  const seen = new Set<string>();
  return sorted.filter((e) => {
    if (seen.has(e.command.name)) return false;
    seen.add(e.command.name);
    return true;
  });
}

/** 这个字符在 start 位置能不能当命令开头:/、全角/;中文输入法下按 / 打出来的「、」只认在整段开头 */
function isSlashAt(text: string, start: number) {
  const c = text[start];
  if (c === "/" || c === "／") return true;
  return c === "、" && text.slice(0, start).trim() === "";
}

export function detectSlash(text: string, cursor: number): SlashToken | null {
  if (cursor < 0 || cursor > text.length) return null;
  let start = cursor;
  while (start > 0 && !isSpace(text[start - 1])) start--;
  if (start === cursor || !isSlashAt(text, start)) return null;
  let end = cursor;
  while (end < text.length && !isSpace(text[end])) end++;
  if (/[/／]/.test(text.slice(start + 1, end))) return null;
  return { start, end, query: text.slice(start + 1, cursor) };
}

function isSubsequence(q: string, s: string) {
  let i = 0;
  for (const ch of s) if (ch === q[i]) i++;
  return i === q.length;
}

export function matchTier(c: SlashCommand, query: string): number {
  const q = query.trim().toLowerCase();
  const title = c.title.toLowerCase();
  const names = [c.name, ...(c.aliases ?? [])];
  if (names.includes(q)) return 0;
  if (names.some((n) => n.startsWith(q))) return 1;
  if (names.some((n) => n.includes(q)) || title.includes(q)) return 2;
  if (isSubsequence(q, c.name) || isSubsequence(q, title)) return 3;
  if (c.desc.toLowerCase().includes(q)) return 4;
  return -1;
}

/** 边输边过滤:能用的在前、灰显的在后;各自按匹配档次排,同档保持原顺序;空输入不筛 */
export function filterCommands(entries: readonly SlashEntry[], query: string): SlashEntry[] {
  const off = (e: SlashEntry) => (e.disabled === undefined ? 0 : 1);
  if (!query.trim()) return entries.map((e, i) => ({ e, i })).sort((a, b) => off(a.e) - off(b.e) || a.i - b.i).map((x) => x.e);
  return entries
    .map((e, i) => ({ e, i, t: matchTier(e.command, query) }))
    .filter((x) => x.t >= 0)
    .sort((a, b) => off(a.e) - off(b.e) || a.t - b.t || a.i - b.i)
    .map((x) => x.e);
}

export function formatUsage(c: SlashCommand): string {
  return [`/${c.name}`, ...c.args.map((a) => (a.required ? `<${a.name}>` : `[${a.name}]`))].join(" ");
}

export function completeToken(text: string, token: SlashToken, name: string): { text: string; cursor: number } {
  const before = text.slice(0, token.start).trim();
  const after = text.slice(token.end).trim();
  const head = `/${name} `;
  if (!before) return { text: head + after, cursor: head.length };
  const out = head + [before, after].filter(Boolean).join(" ");
  return { text: out, cursor: out.length };
}

export function removeToken(text: string, token: SlashToken): { text: string; cursor: number } {
  const before = text.slice(0, token.start).replace(/\s+$/, "");
  const after = text.slice(token.end).replace(/^\s+/, "");
  const sep = before && after ? " " : "";
  return { text: before + sep + after, cursor: before.length + sep.length };
}

function readToken(s: string, pos: number) {
  const open = s[pos]!;
  const close = QUOTES[open];
  if (close !== undefined) {
    const j = s.indexOf(close, pos + 1);
    if (j < 0) return { value: s.slice(pos + 1), end: s.length, closed: false };
    return { value: s.slice(pos + 1, j), end: j + 1, closed: true };
  }
  let end = pos;
  while (end < s.length && !isSpace(s[end])) end++;
  return { value: s.slice(pos, end), end, closed: true };
}

export function looksLikeTime(s: string): boolean {
  const t = s.trim();
  if (!t) return false;
  const f = t.split(/\s+/);
  if (f.length === 5 && f.every((x) => /^[\d*,/-]+$/.test(x))) return true;
  if (/\d{1,2}\s*[:：]\s*\d{2}/.test(t) || /\d{1,2}\s*点/.test(t) || /[一二两三四五六七八九十]+点/.test(t)) return true;
  return /^(每天|每日|每周|每个|每隔|每小时|每\d+|工作日|周末|周[一二三四五六日天]|星期[一二三四五六日天]|今天|明天|后天|今晚|明早|上午|下午|中午|早上|晚上)/.test(t);
}

export function scheduleHint(when: string): { time?: string; repeat?: "每天" | "工作日" | "每周一" | "一次"; cron?: string } {
  const t = when.trim();
  const f = t.split(/\s+/);
  const pad = (n: number) => String(n).padStart(2, "0");
  if (f.length === 5 && f.every((x) => /^[\d*,/-]+$/.test(x))) {
    const [mi, hr, dom, mon, dow] = f as [string, string, string, string, string];
    const out: { time?: string; repeat?: "每天" | "工作日" | "每周一"; cron: string } = { cron: t };
    if (/^\d{1,2}$/.test(mi) && /^\d{1,2}$/.test(hr) && Number(mi) < 60 && Number(hr) < 24) out.time = `${pad(Number(hr))}:${pad(Number(mi))}`;
    if (out.time && dom === "*" && mon === "*") {
      if (dow === "*") out.repeat = "每天";
      else if (dow === "1-5") out.repeat = "工作日";
      else if (dow === "1") out.repeat = "每周一";
    }
    return out;
  }
  const out: { time?: string; repeat?: "每天" | "工作日" | "每周一" | "一次" } = {};
  const clock = /(\d{1,2})\s*[:：]\s*(\d{2})/.exec(t);
  const dian = /(\d{1,2})\s*点\s*(半|(\d{1,2})\s*分?)?/.exec(t);
  let h: number | undefined, m = 0;
  if (clock) { h = Number(clock[1]); m = Number(clock[2]); }
  else if (dian) { h = Number(dian[1]); m = dian[2] === "半" ? 30 : dian[3] ? Number(dian[3]) : 0; }
  if (h !== undefined && /下午|晚上|傍晚|今晚/.test(t) && h < 12) h += 12;
  if (h !== undefined && h < 24 && m < 60) out.time = `${pad(h)}:${pad(m)}`;
  if (/工作日/.test(t)) out.repeat = "工作日";
  else if (/每周一|每个周一|每星期一/.test(t)) out.repeat = "每周一";
  else if (/每天|每日/.test(t)) out.repeat = "每天";
  else if (/今天|明天|后天|今晚|明早/.test(t)) out.repeat = "一次";
  return out;
}

export function parseInvocation(text: string, entries: readonly SlashEntry[], opts: SlashParseOptions = {}): SlashInvocation | null {
  const lead = text.length - text.trimStart().length;
  if (!isSlashAt(text, lead)) return null;
  let i = lead + 1;
  while (i < text.length && !isSpace(text[i])) i++;
  const name = text.slice(lead + 1, i).toLowerCase();
  const entry = entries.find((e) => e.command.name === name) ?? entries.find((e) => e.command.aliases?.includes(name));
  if (!entry) return null;
  const command = entry.command;
  const blocked = entry.disabled;
  const rest = text.slice(i);
  const people = opts.people ? [...opts.people].sort((a, b) => b.length - a.length) : undefined;

  const states: SlashArgState[] = [];
  let pos = 0;
  let lastFilled = -1;
  let openQuote = false;
  const skip = () => { while (pos < rest.length && isSpace(rest[pos])) pos++; };
  for (const arg of command.args) {
    skip();
    if (pos >= rest.length) { states.push({ arg, value: undefined, error: undefined }); continue; }
    let value: string;
    if (arg.rest) {
      const whole = rest.slice(pos).trim();
      const tk = readToken(rest, pos);
      value = QUOTES[rest[pos]!] !== undefined && tk.end >= rest.trimEnd().length ? tk.value : whole;
      openQuote = QUOTES[rest[pos]!] !== undefined && !tk.closed;
      pos = rest.length;
    } else if (arg.kind === "person" && rest[pos] === "@" && people) {
      const hit = people.find((p) => rest.startsWith(p, pos + 1) && (pos + 1 + p.length === rest.length || isSpace(rest[pos + 1 + p.length])));
      if (hit !== undefined) { value = hit; pos += 1 + hit.length; openQuote = false; }
      else { const tk = readToken(rest, pos); value = tk.value.slice(1); pos = tk.end; openQuote = false; }
    } else {
      const tk = readToken(rest, pos);
      value = arg.kind === "person" ? tk.value.replace(/^@/, "") : tk.value;
      pos = tk.end;
      openQuote = !tk.closed;
    }
    lastFilled = states.length;
    states.push({ arg, value, error: undefined });
  }
  skip();
  const extra = rest.slice(pos).trim();

  const endsInWord = rest.length > 0 && !isSpace(rest[rest.length - 1]);
  const typing = openQuote || (endsInWord && !extra && lastFilled >= 0);
  let current: number;
  if (extra) current = -1;
  else if (typing) current = lastFilled;
  else current = states.findIndex((s) => s.value === undefined);

  const missing: string[] = [];
  const errors: string[] = [];
  for (const s of states) {
    const a = s.arg;
    if (s.value === undefined || s.value === "") {
      s.value = s.value === "" ? undefined : s.value;
      if (a.required) missing.push(a.name);
      continue;
    }
    const v = s.value;
    if (a.kind === "choice") {
      const opt = (a.options ?? []).find((o) => o.toLowerCase() === v.toLowerCase());
      if (opt === undefined) s.error = `「${a.name}」只能是 ${(a.options ?? []).join(" / ")}`;
      else s.value = opt;
    } else if (a.kind === "number") {
      if (!/^-?\d+(\.\d+)?$/.test(v)) s.error = `「${a.name}」要填数字`;
    } else if (a.kind === "time") {
      if (!looksLikeTime(v)) s.error = `「${a.name}」看不懂,试试 每天 9:00、工作日 18:30 或 0 9 * * 1-5`;
    } else if (a.kind === "person" && people) {
      const p = people.find((x) => x.toLowerCase() === v.toLowerCase());
      if (p === undefined) s.error = `这里没有叫「${v}」的成员`;
      else s.value = p;
    }
    if (s.error) errors.push(s.error);
  }
  if (extra) errors.push(command.args.length ? `多了「${extra}」` : `/${command.name} 不带参数,多了「${extra}」`);
  if (blocked !== undefined) errors.unshift(blocked);

  const values: Record<string, string> = {};
  for (const s of states) if (s.value !== undefined) values[s.arg.name] = s.value;
  return { command, blocked, args: states, values, current, typing, missing, errors, extra, ok: !missing.length && !errors.length };
}

export function toRunParams(inv: SlashInvocation, conv: string): { conv: string; command: string; source: SlashSource; version?: string; values: Record<string, string> } {
  const base = { conv, command: inv.command.name, source: inv.command.source, values: { ...inv.values } };
  return inv.command.version === undefined ? base : { ...base, version: inv.command.version };
}
