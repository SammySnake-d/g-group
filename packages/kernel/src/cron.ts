// 定时归联系人(概念卡 v2 第 11 张,#1286):cron 表达式 + IANA 时区,宿主算下次触发时间。
// 五段:分 时 日 月 周。每段支持 *、数字、a-b、a-b/n、*/n、逗号列表;月支持 JAN–DEC,周支持 SUN–SAT(0 与 7 都是周日)。
// 日与周都受限(都不是 *)时按 Vixie cron 规则取「或」。
// 时区按 Intl 计算本地时间,夏令时:跳过的本地时刻(春季拨快)不触发;重复的本地时刻(秋季拨慢)只在第一次触发。
// 纯函数,不读系统时区。

export interface CronSpec {
  readonly minutes: readonly number[];
  readonly hours: readonly number[];
  readonly days: readonly number[];
  readonly months: readonly number[];
  readonly weekdays: readonly number[];
  readonly dayAny: boolean;
  readonly weekdayAny: boolean;
}
export type CronParse = { readonly ok: true; readonly spec: CronSpec } | { readonly ok: false; readonly error: string };

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const DAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
const FIELDS = [
  { name: "分", min: 0, max: 59, names: null },
  { name: "时", min: 0, max: 23, names: null },
  { name: "日", min: 1, max: 31, names: null },
  { name: "月", min: 1, max: 12, names: MONTHS },
  { name: "周", min: 0, max: 7, names: DAYS },
] as const;

function parseField(src: string, f: (typeof FIELDS)[number]): number[] | string {
  const out = new Set<number>();
  const val = (s: string): number | null => {
    if (/^\d+$/.test(s)) return Number(s);
    const i = f.names ? f.names.indexOf(s.toUpperCase() as never) : -1;
    if (i < 0) return null;
    return f.names === MONTHS ? i + 1 : i;
  };
  for (const part of src.split(",")) {
    const m = /^(\*|[A-Za-z0-9]+(?:-[A-Za-z0-9]+)?)(?:\/(\d+))?$/.exec(part);
    if (!m) return `${f.name}字段「${part}」看不懂`;
    const step = m[2] === undefined ? 1 : Number(m[2]);
    if (step < 1) return `${f.name}字段步长必须 ≥ 1`;
    let lo: number;
    let hi: number;
    if (m[1] === "*") {
      lo = f.min;
      hi = f.max === 7 ? 6 : f.max;
    } else {
      const [a, b] = m[1]!.split("-");
      const va = val(a!);
      const vb = b === undefined ? (m[2] === undefined ? va : f.max === 7 ? 6 : f.max) : val(b);
      if (va === null || vb === null) return `${f.name}字段「${part}」有不认识的值`;
      lo = va;
      hi = vb;
    }
    if (lo < f.min || hi > f.max || lo > hi) return `${f.name}字段「${part}」超出范围 ${f.min}–${f.max}`;
    for (let v = lo; v <= hi; v += step) out.add(f.max === 7 && v === 7 ? 0 : v);
  }
  return [...out].sort((a, b) => a - b);
}

export function parseCron(expr: string): CronParse {
  if (typeof expr !== "string") return { ok: false, error: "cron 必须是字符串" };
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return { ok: false, error: `cron 要 5 段(分 时 日 月 周),这里有 ${parts.length} 段` };
  const vals: number[][] = [];
  for (let i = 0; i < 5; i++) {
    const r = parseField(parts[i]!, FIELDS[i]!);
    if (typeof r === "string") return { ok: false, error: r };
    vals.push(r);
  }
  return {
    ok: true,
    spec: Object.freeze({
      minutes: vals[0]!,
      hours: vals[1]!,
      days: vals[2]!,
      months: vals[3]!,
      weekdays: vals[4]!,
      dayAny: parts[2] === "*",
      weekdayAny: parts[4] === "*",
    }),
  };
}

export function isValidTimeZone(tz: string): boolean {
  if (typeof tz !== "string" || !tz) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

interface Local {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
}
const fmtCache = new Map<string, Intl.DateTimeFormat>();
function localOf(ms: number, tz: string): Local {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" });
    fmtCache.set(tz, f);
  }
  const p: Record<string, number> = {};
  for (const x of f.formatToParts(new Date(ms))) if (x.type !== "literal") p[x.type] = Number(x.value);
  return { y: p.year!, mo: p.month!, d: p.day!, h: p.hour!, mi: p.minute! };
}
/** 本地时刻 → UTC 毫秒;不存在的本地时刻返回 null,重复的返回较早那个。 */
function utcOf(l: Local, tz: string): number | null {
  const guess = Date.UTC(l.y, l.mo - 1, l.d, l.h, l.mi);
  const hits: number[] = [];
  // 时区偏移在 -14h..+14h 之间:用两个候选偏移试探
  for (const probe of [guess - 14 * 3600_000, guess, guess + 14 * 3600_000]) {
    const lp = localOf(probe, tz);
    const offset = Date.UTC(lp.y, lp.mo - 1, lp.d, lp.h, lp.mi) - probe;
    const cand = guess - offset;
    const lc = localOf(cand, tz);
    if (lc.y === l.y && lc.mo === l.mo && lc.d === l.d && lc.h === l.h && lc.mi === l.mi && !hits.includes(cand)) hits.push(cand);
  }
  return hits.length ? Math.min(...hits) : null;
}

const daysIn = (y: number, mo: number) => new Date(Date.UTC(y, mo, 0)).getUTCDate();

function dayMatches(s: CronSpec, y: number, mo: number, d: number): boolean {
  if (!s.months.includes(mo)) return false;
  const dow = new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
  const dm = s.days.includes(d);
  const wm = s.weekdays.includes(dow);
  if (s.dayAny && s.weekdayAny) return true;
  if (s.dayAny) return wm;
  if (s.weekdayAny) return dm;
  return dm || wm;
}

/** afterMs 之后(严格大于)的接下来 count 次触发时间(UTC 毫秒)。最多向前找 5 年。 */
export function nextRuns(spec: CronSpec, tz: string, afterMs: number, count = 1): number[] {
  if (!isValidTimeZone(tz)) throw new RangeError(`不认识的时区 ${tz}`);
  const out: number[] = [];
  const start = localOf(afterMs, tz);
  let y = start.y;
  let mo = start.mo;
  let d = start.d;
  const limitYear = start.y + 5;
  while (out.length < count && y <= limitYear) {
    if (dayMatches(spec, y, mo, d)) {
      for (const h of spec.hours) {
        for (const mi of spec.minutes) {
          const t = utcOf({ y, mo, d, h, mi }, tz);
          if (t !== null && t > afterMs && !out.includes(t)) {
            out.push(t);
            if (out.length >= count) return out.sort((a, b) => a - b);
          }
        }
      }
    }
    d++;
    if (d > daysIn(y, mo)) {
      d = 1;
      mo++;
      if (mo > 12) {
        mo = 1;
        y++;
      }
    }
  }
  return out.sort((a, b) => a - b);
}

const pad = (n: number) => String(n).padStart(2, "0");
/** 人话描述,给表单预览。 */
export function describeCron(spec: CronSpec, tz: string): string {
  const times =
    spec.hours.length * spec.minutes.length <= 6
      ? spec.hours.flatMap((h) => spec.minutes.map((m) => `${pad(h)}:${pad(m)}`)).join("、")
      : `${spec.hours.length === 24 ? "每小时" : `${spec.hours.length} 个小时`}的 ${spec.minutes.length === 60 ? "每分钟" : `${spec.minutes.length} 个分钟点`}`;
  let days: string;
  if (spec.dayAny && spec.weekdayAny) days = "每天";
  else if (spec.dayAny) days = `每周${spec.weekdays.map((w) => "日一二三四五六"[w]).join("、")}`;
  else if (spec.weekdayAny) days = `每月 ${spec.days.join("、")} 日`;
  else days = `每月 ${spec.days.join("、")} 日或每周${spec.weekdays.map((w) => "日一二三四五六"[w]).join("、")}`;
  const months = spec.months.length === 12 ? "" : `(仅 ${spec.months.join("、")} 月)`;
  return `${days}${months} ${times}(${tz})`;
}
