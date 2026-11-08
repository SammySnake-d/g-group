// 斜杠命令(Telegram 式):在输入框里打 / 唤出能力。
// 这里只放纯逻辑:命令模型、光标处识别、过滤排序、选中后的文本替换、参数解析与校验。
// 命令清单和执行参数都是纯数据,将来由后端 commands.list 给清单、commands.run 接执行(见 toRunParams)。

export type SlashArgKind = "text" | "person" | "choice" | "number" | "time";

export interface SlashArg {
  /** 参数名,显示在提示里,如「何时」「做什么」 */
  name: string;
  kind: SlashArgKind;
  required: boolean;
  /** 占位说明:告诉用户这一格怎么填 */
  hint: string;
  /** kind = choice 时的可选值 */
  options?: readonly string[];
  /** 吞掉剩下的全部文本(只能是最后一个参数),适合「内容」这类带空格的长文本 */
  rest?: boolean;
}

/** 命令从哪来:内置 / 某个插件 / 某个助手 */
export type SlashSource = "builtin" | `plugin:${string}` | `assistant:${string}`;
/** 在哪能用:群聊 / 私聊 / 都可 */
export type SlashScope = "group" | "dm" | "any";

export interface SlashCommand {
  /** 小写字母、数字和 -,如 summary、schedule */
  name: string;
  /** 中文名 */
  title: string;
  /** 一句说明 */
  desc: string;
  args: readonly SlashArg[];
  source: SlashSource;
  scope: SlashScope;
}

/** 当前会话的情况:是群还是私聊、挂了哪些插件、有哪些助手 */
export interface SlashWhere {
  scope: "group" | "dm";
  plugins: readonly string[];
  assistants: readonly string[];
}

/** 光标处识别出的命令片段:start 指向 /,end 是这个词的结尾(替换范围),query 是 / 到光标之间的文字 */
export interface SlashToken {
  start: number;
  end: number;
  query: string;
}

export interface SlashArgState {
  arg: SlashArg;
  /** 已经填了的值(去掉引号;person 去掉 @;choice / person 规范成标准写法);没填是 undefined */
  value: string | undefined;
  error: string | undefined;
}

export interface SlashInvocation {
  command: SlashCommand;
  args: SlashArgState[];
  /** 参数名 → 值,只含填了的 */
  values: Record<string, string>;
  /** 正在填或下一个该填的参数下标;全部填完是 -1 */
  current: number;
  /** current 这一格是不是还在输入中(末尾没有空白,或引号还没闭合) */
  typing: boolean;
  /** 还没填的必填参数名 */
  missing: string[];
  /** 校验错误(choice / number / time / person / 多余文字) */
  errors: string[];
  /** 参数之外多出来的文字 */
  extra: string;
  ok: boolean;
}

export interface SlashParseOptions {
  /** 会话里能 @ 的人名(可带空格,如 Claude Code)。给了才按名单匹配和校验 person 参数 */
  people?: readonly string[];
}

const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const KINDS: readonly string[] = ["text", "person", "choice", "number", "time"];
const SCOPES: readonly string[] = ["group", "dm", "any"];
const QUOTES: Readonly<Record<string, string>> = { '"': '"', "'": "'", "“": "”", "「": "」" };
const isSpace = (c: string | undefined) => c !== undefined && /\s/.test(c);

/** 命令名:小写字母数字和 -,不以 - 开头结尾,不超过 32 个字符 */
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

/** 检查一条命令定义(后端给的也要过这一关),返回问题列表;没问题返回空数组 */
export function checkCommand(c: SlashCommand): string[] {
  const out: string[] = [];
  if (!isCommandName(c.name)) out.push(`命令名「${c.name}」只能用小写字母、数字和 -`);
  if (!c.title.trim()) out.push(`/${c.name} 缺中文名`);
  if (!parseSource(c.source)) out.push(`/${c.name} 的来源「${c.source}」认不出`);
  if (!SCOPES.includes(c.scope)) out.push(`/${c.name} 的范围「${c.scope}」认不出`);
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

/** 这个会话里能用的命令:定义合法、范围对得上、插件挂在本会话、助手在本会话;同名只留一条(内置优先)。
 *  顺序:内置 → 插件 → 助手,各组内保持给定顺序。 */
export function availableCommands(all: readonly SlashCommand[], where: SlashWhere): SlashCommand[] {
  const rank = (c: SlashCommand) => (c.source === "builtin" ? 0 : c.source.startsWith("plugin:") ? 1 : 2);
  const ok = all.filter((c) => {
    if (checkCommand(c).length) return false;
    if (c.scope !== "any" && c.scope !== where.scope) return false;
    const src = parseSource(c.source);
    if (src?.kind === "plugin") return where.plugins.includes(src.id);
    if (src?.kind === "assistant") return where.assistants.includes(src.id);
    return true;
  });
  const sorted = ok.map((c, i) => ({ c, i })).sort((a, b) => rank(a.c) - rank(b.c) || a.i - b.i).map((x) => x.c);
  const seen = new Set<string>();
  return sorted.filter((c) => {
    if (seen.has(c.name)) return false;
    seen.add(c.name);
    return true;
  });
}

/** 这个字符在 start 位置能不能当命令开头:/、全角/;中文输入法下按 / 打出来的「、」只认在整段开头 */
function isSlashAt(text: string, start: number) {
  const c = text[start];
  if (c === "/" || c === "／") return true;
  return c === "、" && text.slice(0, start).trim() === "";
}

/** 光标处的命令片段。只认输入框开头或空白后面的 /xxx;网址、路径里的 / 不算。 */
export function detectSlash(text: string, cursor: number): SlashToken | null {
  if (cursor < 0 || cursor > text.length) return null;
  let start = cursor;
  while (start > 0 && !isSpace(text[start - 1])) start--;
  if (start === cursor || !isSlashAt(text, start)) return null;
  let end = cursor;
  while (end < text.length && !isSpace(text[end])) end++;
  // 词里再有 / 就是路径或网址(/tmp/a、//x),不弹
  if (/[/／]/.test(text.slice(start + 1, end))) return null;
  return { start, end, query: text.slice(start + 1, cursor) };
}

function isSubsequence(q: string, s: string) {
  let i = 0;
  for (const ch of s) if (ch === q[i]) i++;
  return i === q.length;
}

/** 一条命令和输入的匹配档次,越小越靠前:0 名字完全相同、1 名字前缀、2 名字或中文名包含、3 子序列模糊、4 说明里包含;不匹配 -1 */
export function matchTier(c: SlashCommand, query: string): number {
  const q = query.trim().toLowerCase();
  const title = c.title.toLowerCase();
  if (c.name === q) return 0;
  if (c.name.startsWith(q)) return 1;
  if (c.name.includes(q) || title.includes(q)) return 2;
  if (isSubsequence(q, c.name) || isSubsequence(q, title)) return 3;
  if (c.desc.toLowerCase().includes(q)) return 4;
  return -1;
}

/** 边输边过滤:按匹配档次排,同档保持原顺序;空输入返回全部 */
export function filterCommands(cmds: readonly SlashCommand[], query: string): SlashCommand[] {
  if (!query.trim()) return [...cmds];
  return cmds
    .map((c, i) => ({ c, i, t: matchTier(c, query) }))
    .filter((x) => x.t >= 0)
    .sort((a, b) => a.t - b.t || a.i - b.i)
    .map((x) => x.c);
}

/** 用法串:/schedule <何时> <做什么>,可选参数用 [] */
export function formatUsage(c: SlashCommand): string {
  return [`/${c.name}`, ...c.args.map((a) => (a.required ? `<${a.name}>` : `[${a.name}]`))].join(" ");
}

/** 选中命令(补全):把片段换成 "/name ";片段前面已经写了字,就把命令挪到开头,原来的字接在后面当参数 */
export function completeToken(text: string, token: SlashToken, name: string): { text: string; cursor: number } {
  const before = text.slice(0, token.start).trim();
  const after = text.slice(token.end).trim();
  const head = `/${name} `;
  if (!before) return { text: head + after, cursor: head.length };
  const out = head + [before, after].filter(Boolean).join(" ");
  return { text: out, cursor: out.length };
}

/** 去掉片段(不带参数的命令选中即执行,输入框里剩下原来的字) */
export function removeToken(text: string, token: SlashToken): { text: string; cursor: number } {
  const before = text.slice(0, token.start).replace(/\s+$/, "");
  const after = text.slice(token.end).replace(/^\s+/, "");
  const sep = before && after ? " " : "";
  return { text: before + sep + after, cursor: before.length + sep.length };
}

/** 读一个词:引号包住的整段(可带空格)或到下一个空白为止 */
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

/** 看起来像不像一个时间:钟点(9:30、9点)、cron 五段、或「每天 / 工作日 / 明天 / 周一…」这类说法 */
export function looksLikeTime(s: string): boolean {
  const t = s.trim();
  if (!t) return false;
  const f = t.split(/\s+/);
  if (f.length === 5 && f.every((x) => /^[\d*,/-]+$/.test(x))) return true;
  if (/\d{1,2}\s*[:：]\s*\d{2}/.test(t) || /\d{1,2}\s*点/.test(t) || /[一二两三四五六七八九十]+点/.test(t)) return true;
  return /^(每天|每日|每周|每个|每隔|每小时|每\d+|工作日|周末|周[一二三四五六日天]|星期[一二三四五六日天]|今天|明天|后天|今晚|明早|上午|下午|中午|早上|晚上)/.test(t);
}

/** 把「何时」翻成现有定时编辑器能预填的几项(钟点、重复方式;cron 原样带上)。
 *  只做预填,不替代定时模块的表达式解析;认不出的项留空,让用户在编辑器里补。 */
export function scheduleHint(when: string): { time?: string; repeat?: "每天" | "工作日" | "每周一" | "一次"; cron?: string } {
  const t = when.trim();
  const f = t.split(/\s+/);
  const pad = (n: number) => String(n).padStart(2, "0");
  if (f.length === 5 && f.every((x) => /^[\d*,/-]+$/.test(x))) {
    const [mi, hr, dom, mon, dow] = f as [string, string, string, string, string];
    const out: { time?: string; repeat?: "每天" | "工作日" | "每周一"; cron: string } = { cron: t };
    if (/^\d{1,2}$/.test(mi) && /^\d{1,2}$/.test(hr) && Number(mi) < 60 && Number(hr) < 24) out.time = `${pad(Number(hr))}:${pad(Number(mi))}`;
    // 只有每天固定钟点这种能落到现有编辑器的才给重复方式;*/15 这类留给定时模块
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

/** 解析输入框里的一条命令(以 /name 开头)。不是已知命令返回 null。默认光标在末尾。 */
export function parseInvocation(text: string, cmds: readonly SlashCommand[], opts: SlashParseOptions = {}): SlashInvocation | null {
  const lead = text.length - text.trimStart().length;
  if (!isSlashAt(text, lead)) return null;
  let i = lead + 1;
  while (i < text.length && !isSpace(text[i])) i++;
  const name = text.slice(lead + 1, i).toLowerCase();
  const command = cmds.find((c) => c.name === name);
  if (!command) return null;
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

  const values: Record<string, string> = {};
  for (const s of states) if (s.value !== undefined) values[s.arg.name] = s.value;
  return { command, args: states, values, current, typing, missing, errors, extra, ok: !missing.length && !errors.length };
}

/** 交给后端执行时的参数(commands.run):纯数据 */
export function toRunParams(inv: SlashInvocation, conv: string): { conv: string; command: string; source: SlashSource; values: Record<string, string> } {
  return { conv, command: inv.command.name, source: inv.command.source, values: { ...inv.values } };
}
