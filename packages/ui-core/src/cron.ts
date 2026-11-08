/* 定时:标准 5 段 cron(分 时 日 月 周)的解析、校验、下次运行时间、中文说明,以及定时的四种叫醒方式。
   - 一律按本地时区算,和用户桌面上的钟一致;夏令时跳掉的时刻不存在,直接跳过。
   - 日、周两段都受限时按 Vixie cron 的「或」语义;只要有一段以 * 开头(含 *\/2 这类),两段按「且」匹配。
   - 错误信息是给人看的中文,能定位到段就写「第 N 段(名)」。 */

export interface CronFieldDef {
  readonly name: string;
  readonly min: number;
  readonly max: number;
}

/** 5 段的名字和取值范围。周段 0 和 7 都是周日 */
export const CRON_FIELDS: readonly CronFieldDef[] = [
  { name: "分", min: 0, max: 59 },
  { name: "时", min: 0, max: 23 },
  { name: "日", min: 1, max: 31 },
  { name: "月", min: 1, max: 12 },
  { name: "周", min: 0, max: 7 },
];

const MONTH_NAMES = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const DOW_NAMES = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
const DOW_ZH = ["日", "一", "二", "三", "四", "五", "六"];

export interface CronSpec {
  /** 规整后的表达式:段之间一个空格,英文名转大写 */
  readonly expr: string;
  readonly fields: readonly string[];
  readonly minutes: readonly number[];
  readonly hours: readonly number[];
  readonly days: readonly number[];
  readonly months: readonly number[];
  /** 0–6,7 已并入 0 */
  readonly weekdays: readonly number[];
  /** 日段 / 周段是否以 * 开头(Vixie 的 DOM_STAR / DOW_STAR) */
  readonly dayStar: boolean;
  readonly weekdayStar: boolean;
}

/** field:出错的是第几段(1–5);整体问题(段数不对、永远不会触发)为 null */
export interface CronError {
  readonly field: number | null;
  readonly message: string;
}

export type CronParse = { readonly ok: true; readonly spec: CronSpec } | { readonly ok: false; readonly error: CronError };

class FieldError extends Error {}

function fieldValue(raw: string, idx: number, where: string): number {
  const def = CRON_FIELDS[idx]!;
  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    if (n < def.min || n > def.max) throw new FieldError(`${where}：${n} 超出 ${def.min}–${def.max}`);
    return n;
  }
  const names = idx === 3 ? MONTH_NAMES : idx === 4 ? DOW_NAMES : null;
  const at = names ? names.indexOf(raw.toUpperCase()) : -1;
  if (at >= 0) return idx === 3 ? at + 1 : at;
  throw new FieldError(`${where}：不认识「${raw}」`);
}

function parseField(token: string, idx: number): number[] {
  const def = CRON_FIELDS[idx]!;
  const where = `第 ${idx + 1} 段（${def.name}）`;
  const out = new Set<number>();
  for (const item of token.split(",")) {
    if (item === "") throw new FieldError(`${where}：逗号前后不能为空`);
    const parts = item.split("/");
    if (parts.length > 2) throw new FieldError(`${where}：「${item}」里只能有一个 /`);
    const [range = "", stepRaw] = parts;
    let step = 1;
    if (stepRaw !== undefined) {
      if (stepRaw === "") throw new FieldError(`${where}：/ 后面要写步长`);
      if (!/^\d+$/.test(stepRaw)) throw new FieldError(`${where}：步长「${stepRaw}」不是正整数`);
      step = Number(stepRaw);
      if (step === 0) throw new FieldError(`${where}：步长不能是 0`);
    }
    let lo: number;
    let hi: number;
    if (range === "*") {
      lo = def.min;
      hi = idx === 4 ? 6 : def.max;
    } else {
      if (range === "") throw new FieldError(`${where}：「${item}」缺少数值`);
      const ends = range.split("-");
      if (ends.length > 2) throw new FieldError(`${where}：范围「${range}」写法不对`);
      const [a = "", b] = ends;
      if (a === "") throw new FieldError(`${where}：范围「${range}」缺少起点`);
      if (b === "") throw new FieldError(`${where}：范围「${range}」缺少终点`);
      lo = fieldValue(a, idx, where);
      // 「5/15」= 从 5 到最大值每 15 个
      hi = b !== undefined ? fieldValue(b, idx, where) : stepRaw !== undefined ? def.max : lo;
      if (lo > hi) throw new FieldError(`${where}：范围 ${a}-${b} 起点大于终点`);
    }
    for (let v = lo; v <= hi; v += step) out.add(idx === 4 ? v % 7 : v);
  }
  return [...out].sort((x, y) => x - y);
}

export function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

function dayMatches(spec: CronSpec, year: number, month: number, day: number): boolean {
  const domOk = spec.days.includes(day);
  const dowOk = spec.weekdays.includes(new Date(year, month - 1, day).getDay());
  return !spec.dayStar && !spec.weekdayStar ? domOk || dowOk : domOk && dowOk;
}

/** 28 年里星期和闰年的组合全部出现一遍(1901–2099 内),找不到一天能跑就是永远不会触发 */
function firesSomeDay(spec: CronSpec): boolean {
  for (let y = 2000; y < 2028; y++)
    for (const m of spec.months)
      for (let d = 1; d <= daysInMonth(y, m); d++) if (dayMatches(spec, y, m, d)) return true;
  return false;
}

export function parseCron(expr: string): CronParse {
  const fields = expr.trim().split(/\s+/).filter(Boolean);
  if (fields.length === 0) return { ok: false, error: { field: null, message: "还没写表达式：要 5 段，分 时 日 月 周" } };
  if (fields.length !== 5)
    return { ok: false, error: { field: null, message: `要 5 段（分 时 日 月 周），现在是 ${fields.length} 段` } };
  const sets: number[][] = [];
  for (let i = 0; i < 5; i++) {
    try {
      sets.push(parseField(fields[i]!, i));
    } catch (e) {
      if (e instanceof FieldError) return { ok: false, error: { field: i + 1, message: e.message } };
      throw e;
    }
  }
  const norm = fields.map((f) => f.toUpperCase());
  const spec: CronSpec = {
    expr: norm.join(" "),
    fields: norm,
    minutes: sets[0]!,
    hours: sets[1]!,
    days: sets[2]!,
    months: sets[3]!,
    weekdays: sets[4]!,
    dayStar: norm[2]!.startsWith("*"),
    weekdayStar: norm[4]!.startsWith("*"),
  };
  if (!firesSomeDay(spec)) {
    const why =
      spec.weekdayStar && spec.months.length === 1 && spec.days.length === 1
        ? `${spec.months[0]} 月没有 ${spec.days[0]} 日`
        : spec.weekdayStar
          ? "选的月份里没有这些日子"
          : "没有哪一天同时满足日、月、周";
    return { ok: false, error: { field: null, message: `永远不会触发：${why}` } };
  }
  return { ok: true, spec };
}

/** 校验:合法返回 null,否则返回给人看的错误(带段号) */
export function cronError(expr: string): string | null {
  const p = parseCron(expr);
  return p.ok ? null : p.error.message;
}

/** 搜索上限:30 年。2/29 这种最长要等 8 年(跨 2100),够用,也不会死循环 */
const HORIZON_DAYS = 366 * 30;

/** 从 from 的下一分钟起,按本地时区算接下来 count 次。表达式不合法返回空数组 */
export function nextRuns(expr: string, from: Date, count: number): Date[] {
  const p = parseCron(expr);
  const out: Date[] = [];
  if (!p.ok || Number.isNaN(from.getTime()) || count <= 0) return out;
  const spec = p.spec;
  const start = new Date(from.getTime());
  start.setSeconds(0, 0);
  start.setMinutes(start.getMinutes() + 1);
  const y0 = start.getFullYear();
  const m0 = start.getMonth();
  const d0 = start.getDate();
  for (let i = 0; i < HORIZON_DAYS; i++) {
    const day = new Date(y0, m0, d0 + i);
    const Y = day.getFullYear();
    const M = day.getMonth() + 1;
    const D = day.getDate();
    if (!spec.months.includes(M)) {
      // 整月不跑:直接跳到下个月 1 号的前一天(循环会 +1)
      i += daysInMonth(Y, M) - D;
      continue;
    }
    if (!dayMatches(spec, Y, M, D)) continue;
    const first = i === 0;
    for (const h of spec.hours) {
      if (first && h < start.getHours()) continue;
      for (const m of spec.minutes) {
        if (first && h === start.getHours() && m < start.getMinutes()) continue;
        const t = new Date(Y, M - 1, D, h, m, 0, 0);
        // 夏令时跳过的时刻在本地不存在,会被挪到别的钟点:跳过
        if (t.getHours() !== h || t.getMinutes() !== m || t.getDate() !== D) continue;
        if (t.getTime() <= from.getTime()) continue;
        out.push(t);
        if (out.length >= count) return out;
      }
    }
  }
  return out;
}

const pad = (n: number) => String(n).padStart(2, "0");
const hhmm = (h: number, m: number) => `${pad(h)}:${pad(m)}`;

/** [1,2,3,5] → 「1–3、5」:连续 3 个以上收成范围 */
function compress(nums: readonly number[], show: (n: number) => string = String): string {
  const out: string[] = [];
  for (let i = 0; i < nums.length; ) {
    let j = i;
    while (j + 1 < nums.length && nums[j + 1] === nums[j]! + 1) j++;
    if (j - i >= 2) out.push(`${show(nums[i]!)}–${show(nums[j]!)}`);
    else for (let k = i; k <= j; k++) out.push(show(nums[k]!));
    i = j + 1;
  }
  return out.join("、");
}

/** 周显示按周一到周日排 */
function weekPhrase(ws: readonly number[]): string {
  const order = [...ws].map((w) => (w === 0 ? 7 : w)).sort((a, b) => a - b);
  const key = order.join(",");
  if (key === "1,2,3,4,5") return "工作日";
  if (key === "6,7") return "周末";
  if (order.length === 7) return "每天";
  const name = (n: number) => DOW_ZH[n % 7]!;
  const contiguous = order.every((v, i) => i === 0 || v === order[i - 1]! + 1);
  if (contiguous && order.length >= 3) return `每周${name(order[0]!)}至周${name(order[order.length - 1]!)}`;
  return `每周${order.map(name).join("、")}`;
}

function dayPhrase(s: CronSpec): string | null {
  const [, , fd, fmo, fw] = s.fields;
  const domAll = fd === "*";
  const dowAll = fw === "*";
  const plainDom = !fd!.includes("*");
  if (fmo !== "*") {
    if (domAll && dowAll) return `每年 ${compress(s.months)} 月每天`;
    if (dowAll && plainDom && s.months.length === 1 && s.days.length === 1) return `每年 ${s.months[0]} 月 ${s.days[0]} 日`;
    return null;
  }
  if (domAll && dowAll) return "每天";
  if (domAll) return weekPhrase(s.weekdays);
  if (dowAll && plainDom) return `每月 ${compress(s.days)} 日`;
  if (!s.dayStar && !s.weekdayStar) return `每月 ${compress(s.days)} 日或${weekPhrase(s.weekdays)}`;
  return null;
}

function fallback(s: CronSpec): string {
  const zhWeek = (n: number) => `周${DOW_ZH[n]!}`;
  const seg = (i: number, nums: readonly number[], show?: (n: number) => string) =>
    `${CRON_FIELDS[i]!.name} ${s.fields[i] === "*" ? "任意" : compress(nums, show)}`;
  const parts = [seg(0, s.minutes), seg(1, s.hours), seg(2, s.days), seg(3, s.months), seg(4, s.weekdays, zhWeek)];
  const or = !s.dayStar && !s.weekdayStar ? "（日、周满足其一即可）" : "";
  return `逐段：${parts.join(" · ")}${or}`;
}

/** 中文人话:「每天 09:00」「工作日 09:00」「每周一 10:00」「每 30 分钟」「每小时第 7 分」;复杂的逐段说明。不合法返回空串 */
export function describeCron(expr: string): string {
  const p = parseCron(expr);
  if (!p.ok) return "";
  const s = p.spec;
  const [fm, fh] = s.fields as [string, string];
  const day = dayPhrase(s);
  const prefix = (t: string) => (day === "每天" ? t : `${day}${t}`);
  const stepOf = (f: string) => /^\*\/(\d+)$/.exec(f)?.[1];
  const single = (f: string) => /^\d+$/.test(f);
  if (day === null) return fallback(s);
  if (fm === "*" && fh === "*") return prefix("每分钟");
  const ms = stepOf(fm);
  if (ms && fh === "*") return prefix(`每 ${ms} 分钟`);
  if (ms && !fh.includes("*")) {
    const hrs = compress(s.hours);
    return `${day} ${hrs} 点每 ${ms} 分钟`;
  }
  if (single(fm)) {
    const m = Number(fm);
    const at = m === 0 ? "整点" : `第 ${m} 分`;
    if (fh === "*") return prefix(`每小时${at}`);
    const hs = stepOf(fh);
    if (hs) return prefix(`每 ${hs} 小时${at}`);
  }
  if (!fm.includes("*") && !fh.includes("*") && s.minutes.length * s.hours.length <= 6) {
    const times = s.hours.flatMap((h) => s.minutes.map((m) => hhmm(h, m)));
    return `${day} ${times.join("、")}`;
  }
  return fallback(s);
}

/* ---------- 常用预设 ---------- */

export interface CronPreset {
  readonly id: string;
  readonly label: string;
  readonly expr: string;
}
export const CRON_PRESETS: readonly CronPreset[] = [
  { id: "daily-9", label: "每天 09:00", expr: "0 9 * * *" },
  { id: "weekdays-9", label: "工作日 09:00", expr: "0 9 * * 1-5" },
  { id: "monday-9", label: "每周一 09:00", expr: "0 9 * * 1" },
  { id: "hourly", label: "每小时", expr: "0 * * * *" },
  { id: "every-30m", label: "每 30 分钟", expr: "*/30 * * * *" },
];
export const CUSTOM_PRESET = "custom";

/** 表达式对上哪个预设(空白、大小写不敏感);对不上是 "custom" */
export function cronPresetId(expr: string): string {
  const p = parseCron(expr);
  if (!p.ok) return CUSTOM_PRESET;
  return CRON_PRESETS.find((x) => x.expr === p.spec.expr)?.id ?? CUSTOM_PRESET;
}

/* ---------- 定时的四种叫醒方式 ---------- */

/** 定时怎么被叫醒。同一种东西,只是触发方式不同(#2273):
 *  - cron:按表达式重复,本地时区;
 *  - once:只跑一次,at 是本地时间「YYYY-MM-DDTHH:mm」;
 *  - messages:会话里每有 n 条新消息(只数人和助手说的话)醒一次,seen 是这一轮已经数到几条;
 *  - event:某个插件来源报来一件事、且满足 cond 才醒。source 是插件 id */
export type CronTrigger =
  | { readonly kind: "cron"; readonly expr: string }
  | { readonly kind: "once"; readonly at: string }
  | { readonly kind: "messages"; readonly n: number; readonly seen: number }
  | { readonly kind: "event"; readonly source: string; readonly cond: string };

export type CronTriggerKind = CronTrigger["kind"];

/** 「YYYY-MM-DDTHH:mm」按本地时间解析;日期不存在(2/30)返回 null */
export function parseLocalDateTime(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number) as [number, number, number, number, number];
  const t = new Date(y, mo - 1, d, h, mi, 0, 0);
  if (t.getFullYear() !== y || t.getMonth() !== mo - 1 || t.getDate() !== d || t.getHours() !== h || t.getMinutes() !== mi) return null;
  return t;
}

export function toLocalDateTime(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export const MAX_MESSAGES_TRIGGER = 1000;

/** 保存前校验:合法返回 null,否则返回给人看的错误 */
export function triggerError(t: CronTrigger, now: Date): string | null {
  switch (t.kind) {
    case "cron":
      return cronError(t.expr);
    case "once": {
      const at = parseLocalDateTime(t.at);
      if (!at) return "选一个具体的日期和时间";
      return at.getTime() <= now.getTime() ? "这个时间已经过去了" : null;
    }
    case "messages":
      return Number.isInteger(t.n) && t.n >= 1 && t.n <= MAX_MESSAGES_TRIGGER ? null : `条数要是 1 到 ${MAX_MESSAGES_TRIGGER} 的整数`;
    case "event":
      if (!t.source.trim()) return "选一个插件来源";
      return t.cond.trim() ? null : "写清楚发生什么事才叫醒它";
  }
}

/** 下一次按钟点醒来的时刻;按条数、按事件的没有钟点,返回 null;只跑一次且已过去也是 null */
export function triggerNext(t: CronTrigger, now: Date): Date | null {
  if (t.kind === "cron") return nextRuns(t.expr, now, 1)[0] ?? null;
  if (t.kind === "once") {
    const at = parseLocalDateTime(t.at);
    return at && at.getTime() > now.getTime() ? at : null;
  }
  return null;
}

/** 按条数触发:还差几条醒来 */
export function messagesLeft(t: CronTrigger): number {
  return t.kind === "messages" ? Math.max(0, t.n - t.seen) : 0;
}

/** 一句话说清怎么叫醒(不依赖「现在」,可以写进聊天记录) */
export function describeTrigger(t: CronTrigger): string {
  switch (t.kind) {
    case "cron":
      return describeCron(t.expr) || t.expr;
    case "once": {
      const at = parseLocalDateTime(t.at);
      return at ? `只跑一次：${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${hhmm(at.getHours(), at.getMinutes())}` : "只跑一次";
    }
    case "messages":
      return `每 ${t.n} 条消息`;
    case "event":
      return `当${t.cond}`;
  }
}

const dayNo = (d: Date) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86_400_000;

/** 相对「现在」的时刻:今天 / 明天 / 昨天 09:00,一周内写周几,同年写 11/19,跨年写 2027/1/4 */
export function formatRunAt(d: Date, now: Date): string {
  const t = hhmm(d.getHours(), d.getMinutes());
  const diff = dayNo(d) - dayNo(now);
  if (diff === 0) return `今天 ${t}`;
  if (diff === 1) return `明天 ${t}`;
  if (diff === -1) return `昨天 ${t}`;
  if (Math.abs(diff) < 7) return `周${DOW_ZH[d.getDay()]!} ${t}`;
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}/${d.getDate()} ${t}`;
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${t}`;
}

/** UTC 偏移(分钟,东正西负)→「UTC+8」「UTC-3:30」「UTC」 */
export function utcOffsetLabel(offsetMinutes: number): string {
  if (offsetMinutes === 0) return "UTC";
  const sign = offsetMinutes > 0 ? "+" : "-";
  const abs = Math.abs(offsetMinutes);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return `UTC${sign}${h}${m ? `:${pad(m)}` : ""}`;
}

/** 本地时区说明,定时按它算:「Asia/Shanghai · UTC+8」。偏移取 now 那一刻的(夏令时会变),取不到时区名只写偏移 */
export function localZoneLabel(now: Date, zone?: string): string {
  const name = zone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const off = utcOffsetLabel(-now.getTimezoneOffset());
  return name ? `${name} · ${off}` : off;
}
