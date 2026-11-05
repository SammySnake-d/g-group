// report_progress 汇报的 schema 规则,只此一份:MCP 服务器(mcp/report-mcp.mjs)拒收与适配器解析都调用它。
// 不依赖任何模块,MCP 服务器进程可以直接 import(Node 22.18+ 原生剥离类型)。

export const REPORT_KINDS: readonly string[] = ["started", "milestone", "blocked", "completed", "failed"];
const REPORT_KEYS: readonly string[] = ["kind", "summary", "stage", "needs", "constraintVer", "openQuestions", "doneSideEffects"];

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const nonEmpty = (x: unknown): boolean => typeof x === "string" && x.trim() !== "";
const strArr = (x: unknown): boolean => Array.isArray(x) && x.every((s) => typeof s === "string");

/** 返回违反项;空数组表示合规。字段类型、枚举、条件必填、constraintVer 非负整数、未知字段都查 */
export function reportErrors(input: unknown): string[] {
  if (!isRecord(input)) return ["汇报必须是对象"];
  const a = input;
  const errs: string[] = [];
  const extra = Object.keys(a).filter((k) => !REPORT_KEYS.includes(k));
  if (extra.length) errs.push(`未知字段 ${extra.join(", ")}`);
  if (typeof a.kind !== "string" || !REPORT_KINDS.includes(a.kind)) errs.push("kind 非法");
  if (!nonEmpty(a.summary)) errs.push("summary 须为非空字符串");
  if (a.stage !== undefined && !nonEmpty(a.stage)) errs.push("stage 须为非空字符串");
  if (a.needs !== undefined && !nonEmpty(a.needs)) errs.push("needs 须为非空字符串");
  if (a.kind === "milestone" && a.stage === undefined) errs.push("milestone 缺 stage");
  if (a.kind === "blocked" && a.needs === undefined) errs.push("blocked 缺 needs");
  if (a.constraintVer !== undefined && !(Number.isInteger(a.constraintVer) && (a.constraintVer as number) >= 0)) errs.push("constraintVer 须为非负整数");
  if (a.openQuestions !== undefined && !strArr(a.openQuestions)) errs.push("openQuestions 须为字符串数组");
  if (a.doneSideEffects !== undefined && !strArr(a.doneSideEffects)) errs.push("doneSideEffects 须为字符串数组");
  return errs;
}
