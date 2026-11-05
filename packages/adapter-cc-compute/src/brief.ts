// brief 与交接快照的入口校验:只放行声明过的字段,凭据只收引用句柄,快照必须带约束版本。
import type { Brief, HandoffSnapshot, Placement, Refusal } from "./types.ts";

const BRIEF_KEYS: readonly string[] = ["task", "rules", "tools", "credentialRefs", "placement"];
const SNAPSHOT_KEYS: readonly string[] = ["constraintVer", "openQuestions", "doneSideEffects"];
const PLACEMENTS: ReadonlySet<string> = new Set<Placement>(["local", "byom_daemon", "cloud_sandbox"]);
/** 与 domain contact.briefFor 相同的引用句柄格式 */
export const CREDENTIAL_REF = /^[a-z][a-z0-9+.-]*:\/\/[^\s]+$/;
/** 工具名只许字母数字下划线,避免逗号/空格把别的工具名拼进 CLI 参数 */
const TOOL_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;

const refuse = (reason: string): Refusal => ({ ok: false, reason });
const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const isStrArr = (x: unknown): x is string[] => Array.isArray(x) && x.every((s) => typeof s === "string");

export function checkBrief(x: unknown): { readonly ok: true; readonly brief: Brief } | Refusal {
  if (!isRecord(x)) return refuse("brief 必须是对象");
  const extra = Object.keys(x).filter((k) => !BRIEF_KEYS.includes(k));
  if (extra.length) return refuse(`brief 只收 ${BRIEF_KEYS.join("/")},拒绝额外字段 ${extra.join(", ")}(Compute 不带联系人记忆与 SOUL)`);
  const { task, rules, tools, credentialRefs, placement } = x;
  if (typeof task !== "string" || !task.trim()) return refuse("brief.task 必须是非空字符串");
  if (!isStrArr(rules)) return refuse("brief.rules 必须是字符串数组");
  if (!isStrArr(tools) || tools.some((t) => !TOOL_NAME.test(t))) return refuse("brief.tools 必须是工具名数组(字母、数字、下划线)");
  if (!isStrArr(credentialRefs)) return refuse("brief.credentialRefs 必须是字符串数组");
  if (credentialRefs.some((c) => !CREDENTIAL_REF.test(c))) return refuse("凭据只能给引用句柄(<scheme>://<path>),不能给明文");
  if (typeof placement !== "string" || !PLACEMENTS.has(placement)) return refuse(`未知的运行位置 ${String(placement)}`);
  return {
    ok: true,
    brief: Object.freeze({
      task,
      rules: Object.freeze([...rules]),
      tools: Object.freeze([...tools]),
      credentialRefs: Object.freeze([...credentialRefs]),
      placement: placement as Placement,
    }),
  };
}

export function checkSnapshot(x: unknown): { readonly ok: true; readonly snapshot: HandoffSnapshot } | Refusal {
  if (!isRecord(x)) return refuse("交接快照必须是结构化对象,不能只是一段文字");
  const extra = Object.keys(x).filter((k) => !SNAPSHOT_KEYS.includes(k));
  if (extra.length) return refuse(`交接快照只收 ${SNAPSHOT_KEYS.join("/")},拒绝额外字段 ${extra.join(", ")}`);
  const { constraintVer, openQuestions, doneSideEffects } = x;
  if (!Number.isInteger(constraintVer) || (constraintVer as number) < 0) return refuse("交接快照缺约束版本 constraintVer(非负整数),不能只有流畅文字");
  if (!isStrArr(openQuestions)) return refuse("交接快照的 openQuestions 必须是字符串数组");
  if (!isStrArr(doneSideEffects)) return refuse("交接快照的 doneSideEffects 必须是字符串数组");
  return {
    ok: true,
    snapshot: Object.freeze({
      constraintVer: constraintVer as number,
      openQuestions: Object.freeze([...openQuestions]),
      doneSideEffects: Object.freeze([...doneSideEffects]),
    }),
  };
}
