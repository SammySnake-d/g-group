// 轮边界换模型的计划(AC-51、需求文档 D27 第 4 节):纯函数,不碰进程。
// 输入是会话当前实际在用的 {model, effort}(以 harness 回报为准)与这一轮宿主现场解析出的生效值,输出这一轮在写入输入之前要做的步骤。
//   - 没给生效值、或与当前一致:只发送,不发任何切换请求(AC-51 对照「模型没改 → 不发任何切换请求、不重启」);
//   - 模型不同:能力声明支持会话内换模型 → set-model;不支持 → restart(结束旧进程,用同一会话 id 带新模型重启,D27 第 4 节第 5 条);
//   - 只改 effort:能会话内改 → set-effort;不能 → restart 带新 effort、模型不变;
//   - 当前模型不明(上次切换超时、还没拿到 init):一律当作不同,先切再发。
// 轮进行中不调用本函数:常驻适配器把这一轮的输入排到 result 之后再计划(D27 第 4 节第 3 条);插话(steer)不经过这里。
import { isPlainRecord, plainData } from "./plain.ts";
import type { TurnModel } from "./types.ts";

export type TurnStep =
  | { readonly kind: "set-model"; readonly model: string }
  | { readonly kind: "set-effort"; readonly effort: string }
  | { readonly kind: "restart"; readonly model: string; readonly effort?: string }
  | { readonly kind: "send"; readonly model: string; readonly effort?: string };

export interface SwitchCapabilities {
  /** harness 支持会话内换模型 id(Claude Code set_model) */
  readonly inSessionModelSwitch: boolean;
  /** harness 支持会话内改推理强度 */
  readonly inSessionEffort: boolean;
}

/** 会话当前实际在用的值;model 为 null 表示不明 */
export interface SessionModel {
  readonly model: string | null;
  readonly effort?: string;
}

const isOptStr = (v: unknown) => v === undefined || (typeof v === "string" && v.length > 0);

/** 生效值是外部输入:纯数据、只收 model(非空字符串)与 effort(可选非空字符串);不合格抛受控 TypeError */
export function checkTurnModel(x: unknown): TurnModel | undefined {
  if (x === undefined) return undefined;
  const p = plainData(x, "turn");
  if (!p.ok) throw new TypeError(`这一轮的生效模型必须是纯数据:${p.path} ${p.why}`);
  const v = p.value;
  if (!isPlainRecord(v) || Object.keys(v).some((k) => k !== "model" && k !== "effort")) throw new TypeError("这一轮的生效模型只收 {model, effort?}");
  if (typeof v.model !== "string" || !v.model) throw new TypeError("这一轮的生效模型 model 必须是非空字符串");
  if (!isOptStr(v.effort)) throw new TypeError("这一轮的生效模型 effort 必须是非空字符串");
  return Object.freeze(v.effort === undefined ? { model: v.model } : { model: v.model, effort: v.effort as string });
}

/** 会话当前值与能力声明也是外部输入(经包根导出,R6-01):先过纯数据合同再读字段,不合格抛受控 TypeError */
function checkSession(x: unknown): SessionModel {
  const p = plainData(x, "current");
  if (!p.ok) throw new TypeError(`会话当前模型必须是纯数据:${p.path} ${p.why}`);
  const v = p.value;
  if (!isPlainRecord(v) || Object.keys(v).some((k) => k !== "model" && k !== "effort")) throw new TypeError("会话当前模型只收 {model, effort?}");
  if (v.model !== null && (typeof v.model !== "string" || !v.model)) throw new TypeError("会话当前模型 model 必须是非空字符串或 null");
  if (!isOptStr(v.effort)) throw new TypeError("会话当前模型 effort 必须是非空字符串");
  return v.effort === undefined ? { model: v.model as string | null } : { model: v.model as string | null, effort: v.effort as string };
}
function checkCaps(x: unknown): SwitchCapabilities {
  const p = plainData(x, "caps");
  if (!p.ok) throw new TypeError(`能力声明必须是纯数据:${p.path} ${p.why}`);
  const v = p.value;
  if (!isPlainRecord(v) || typeof v.inSessionModelSwitch !== "boolean" || typeof v.inSessionEffort !== "boolean") throw new TypeError("能力声明必须是 {inSessionModelSwitch: 布尔, inSessionEffort: 布尔}");
  return { inSessionModelSwitch: v.inSessionModelSwitch, inSessionEffort: v.inSessionEffort };
}

export function planTurn(currentInput: SessionModel, desired: TurnModel | undefined, capsInput: SwitchCapabilities): readonly TurnStep[] {
  const current = checkSession(currentInput);
  const caps = checkCaps(capsInput);
  const want = checkTurnModel(desired);
  if (!want) {
    if (current.model === null) throw new TypeError("会话当前模型不明且这一轮没有给生效模型,不能发送");
    return Object.freeze([Object.freeze({ kind: "send", model: current.model, ...(current.effort !== undefined ? { effort: current.effort } : {}) } as TurnStep)]);
  }
  const effort = want.effort ?? current.effort;
  const modelDiffers = current.model !== want.model;
  const effortDiffers = want.effort !== undefined && want.effort !== current.effort;
  const send: TurnStep = Object.freeze({ kind: "send", model: want.model, ...(effort !== undefined ? { effort } : {}) });
  const steps: TurnStep[] = [];
  const needRestart = (modelDiffers && !caps.inSessionModelSwitch) || (effortDiffers && !caps.inSessionEffort);
  if (needRestart) {
    steps.push(Object.freeze({ kind: "restart", model: want.model, ...(effort !== undefined ? { effort } : {}) }));
  } else {
    if (modelDiffers) steps.push(Object.freeze({ kind: "set-model", model: want.model }));
    if (effortDiffers) steps.push(Object.freeze({ kind: "set-effort", effort: want.effort as string }));
  }
  steps.push(send);
  return Object.freeze(steps);
}

/** harness 拒绝切换的原因分类:模型被拒(check_failed 等)→ 这一轮失败给两条修复路径;切换请求本身不可用 → 走兜底重启 */
export function switchRefusalKind(errorCode: unknown, errorText: unknown): "model-rejected" | "unavailable" {
  // 只收字符串或缺省:对象(含 Proxy、带 toString 的对象)不做隐式转换,抛受控 TypeError(R6-01、R7-02)
  for (const [name, v] of [["errorCode", errorCode], ["errorText", errorText]] as const) {
    if (v !== undefined && v !== null && typeof v !== "string") throw new TypeError(`switchRefusalKind 的 ${name} 必须是字符串`);
  }
  const code = typeof errorCode === "string" ? errorCode : "";
  const text = typeof errorText === "string" ? errorText : "";
  if (/unsupported|not[_ -]?supported|unknown[_ -](control[_ -])?(request|subtype)/i.test(`${code} ${text}`)) return "unavailable";
  return "model-rejected";
}
