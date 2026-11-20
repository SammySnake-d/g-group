// 只依赖 ./plain.ts 与 node 内置模块,MCP 服务器进程可以直接 import(Node 22.18+ 原生剥离类型)。
import { isPlainRecord, plainData } from "./plain.ts";

export const REPORT_KINDS: readonly string[] = Object.freeze(["started", "milestone", "blocked", "completed", "failed"]);
const REPORT_KEYS: readonly string[] = Object.freeze(["kind", "summary", "stage", "needs", "constraintVer", "openQuestions", "doneSideEffects", "attachments"]);

const deepFreeze = <T>(x: T): T => {
  if (typeof x === "object" && x !== null) for (const v of Object.values(x)) deepFreeze(v);
  return Object.freeze(x);
};

const TOOL = deepFreeze({
  name: "report_progress",
  description:
    "向宿主汇报任务进展。开始干活报 started;完成一个有意义的阶段报 milestone(带 stage);" +
    "需要用户授权/提供信息/外部条件不满足而无法继续时报 blocked(带 needs,有截图就把工作目录里的文件相对路径放进 attachments)并停下;全部完成报 completed;放弃报 failed。" +
    "知道当前生效的约束版本、未决问题或已经做完的有副作用的动作时,带上 constraintVer/openQuestions/doneSideEffects。",
  inputSchema: {
    type: "object",
    properties: {
      kind: { type: "string", enum: [...REPORT_KINDS] },
      summary: { type: "string", description: "一句话,给用户看" },
      stage: { type: "string", description: "阶段名(milestone 时必填)" },
      needs: { type: "string", description: "blocked 时:需要用户做什么" },
      constraintVer: { type: "integer", minimum: 0, description: "当前遵守的群规/硬约束版本号" },
      openQuestions: { type: "array", items: { type: "string" }, description: "仍未决的问题(整份替换)" },
      doneSideEffects: { type: "array", items: { type: "string" }, description: "已经完成、不可重做的副作用(追加)" },
      attachments: { type: "array", items: { type: "string" }, description: "blocked 时:要给用户看的截图等文件,工作目录内的相对路径" },
    },
    required: ["kind", "summary"],
    additionalProperties: false,
  },
});

export function reportToolDefinition(): typeof TOOL {
  return TOOL;
}

const nonEmpty = (x: unknown): boolean => typeof x === "string" && x.trim() !== "";
const strArr = (x: unknown): boolean => Array.isArray(x) && x.every((s) => typeof s === "string");

export function reportErrors(input: unknown): string[] {
  const p = plainData(input, "汇报");
  if (!p.ok) return [`汇报必须是纯数据:${p.path} ${p.why}`];
  if (!isPlainRecord(p.value)) return ["汇报必须是对象"];
  const a = p.value;
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
  if (a.attachments !== undefined && !strArr(a.attachments)) errs.push("attachments 须为字符串数组");
  return errs;
}
