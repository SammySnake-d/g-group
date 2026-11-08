// brief 与交接快照的入口校验:只放行声明过的字段,凭据只收引用句柄,快照必须带约束版本。
// 读取任何字段之前先按纯数据合同判定(plain.ts,R4-01):getter/setter/Proxy 不调用即拒收,之后只读冻结的副本。
import { isPlainRecord, plainData } from "./plain.ts";
import type { Brief, HandoffSnapshot, Placement, Refusal } from "./types.ts";

const BRIEF_KEYS: readonly string[] = Object.freeze(["task", "rules", "tools", "credentialRefs", "placement"]);
const SNAPSHOT_KEYS: readonly string[] = Object.freeze(["constraintVer", "openQuestions", "doneSideEffects"]);
const PLACEMENTS: readonly string[] = Object.freeze(["local", "byom_daemon", "cloud_sandbox"] satisfies Placement[]);
/** 与 domain contact.briefFor 相同的引用句柄格式。不导出:冻结的 RegExp 仍可被 compile 改写,导出就成了可变策略对象 */
const CREDENTIAL_REF = /^[a-z][a-z0-9+.-]*:\/\/[^\s]+$/;
/** 是不是凭据引用句柄(<scheme>://<path>)。只收字符串,其余一律 false */
export const isCredentialRef = (x: unknown): boolean => typeof x === "string" && CREDENTIAL_REF.test(x);
/** 能原样交给 claude --tools 的具体内置工具名。不在这里的(含 CLI 的控制词 default、空串、通配)一律拒绝:
 *  --tools 会把 default 展开成整套内置工具,不能当普通工具名(Codex 审查 F-01)。冻结数组,导出后不可改 */
export const CC_BUILTIN_TOOLS: readonly string[] = Object.freeze(["Read", "Write", "Edit", "Glob", "Grep", "Bash", "NotebookEdit", "WebFetch", "WebSearch"]);

const refuse = (reason: string): Refusal => ({ ok: false, reason });
const isStrArr = (x: unknown): x is readonly string[] => Array.isArray(x) && x.every((s) => typeof s === "string");

export function checkBrief(input: unknown): { readonly ok: true; readonly brief: Brief } | Refusal {
  const p = plainData(input, "brief");
  if (!p.ok) return refuse(`brief 必须是纯数据:${p.path} ${p.why}`);
  const x = p.value;
  if (!isPlainRecord(x)) return refuse("brief 必须是对象");
  const extra = Object.keys(x).filter((k) => !BRIEF_KEYS.includes(k));
  if (extra.length) return refuse(`brief 只收 ${BRIEF_KEYS.join("/")},拒绝额外字段 ${extra.join(", ")}(Compute 不带联系人记忆与 SOUL)`);
  const { task, rules, tools, credentialRefs, placement } = x;
  if (typeof task !== "string" || !task.trim()) return refuse("brief.task 必须是非空字符串");
  if (!isStrArr(rules)) return refuse("brief.rules 必须是字符串数组");
  if (!isStrArr(tools)) return refuse("brief.tools 必须是工具名数组");
  const unknown = tools.filter((t) => !CC_BUILTIN_TOOLS.includes(t));
  if (unknown.length) return refuse(`brief.tools 只收具体的内置工具名(${CC_BUILTIN_TOOLS.join("/")}),拒绝 ${unknown.map((t) => JSON.stringify(t)).join(", ")}`);
  if (!isStrArr(credentialRefs)) return refuse("brief.credentialRefs 必须是字符串数组");
  // 每一个元素都查(R4-04):任何位置出现非引用都拒绝
  const plaintext = credentialRefs.filter((c) => !isCredentialRef(c));
  if (plaintext.length) return refuse("凭据只能给引用句柄(<scheme>://<path>),不能给明文");
  if (typeof placement !== "string" || !PLACEMENTS.includes(placement)) return refuse(`未知的运行位置 ${JSON.stringify(placement)}`);
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

export function checkSnapshot(input: unknown): { readonly ok: true; readonly snapshot: HandoffSnapshot } | Refusal {
  const p = plainData(input, "交接快照");
  if (!p.ok) return refuse(`交接快照必须是纯数据:${p.path} ${p.why}`);
  const x = p.value;
  if (!isPlainRecord(x)) return refuse("交接快照必须是结构化对象,不能只是一段文字");
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
