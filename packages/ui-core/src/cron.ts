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

// const MONTH_NAMES = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
// const DOW_NAMES = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
// const DOW_ZH = ["日", "一", "二", "三", "四", "五", "六"];

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


export function daysInMonth(_year: number, _month: number): number {
  return 0;
}

export function parseCron(_expr: string): CronParse {
  return { ok: false, error: { field: null, message: "" } };
}

export function cronError(_expr: string): string | null {
  return null;
}

export function nextRuns(_expr: string, _from: Date, _count: number): Date[] {
  return [];
}

export function describeCron(_expr: string): string {
  return "";
}

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

export function cronPresetId(_expr: string): string {
  return "";
}

export type CronTrigger =
  | { readonly kind: "cron"; readonly expr: string }
  | { readonly kind: "once"; readonly at: string }
  | { readonly kind: "messages"; readonly n: number; readonly seen: number }
  | { readonly kind: "event"; readonly source: string; readonly cond: string };

export type CronTriggerKind = CronTrigger["kind"];

export function parseLocalDateTime(_s: string): Date | null {
  return null;
}

export function toLocalDateTime(_d: Date): string {
  return "";
}

export const MAX_MESSAGES_TRIGGER = 1000;

export function triggerError(_t: CronTrigger, _now: Date): string | null {
  return null;
}

export function triggerNext(_t: CronTrigger, _now: Date): Date | null {
  return null;
}

export function messagesLeft(_t: CronTrigger): number {
  return -1;
}

export function describeTrigger(_t: CronTrigger): string {
  return "";
}

export function formatRunAt(_d: Date, _now: Date): string {
  return "";
}

export function utcOffsetLabel(_offsetMinutes: number): string {
  return "";
}

export function localZoneLabel(_now: Date, _zone?: string): string {
  return "";
}
