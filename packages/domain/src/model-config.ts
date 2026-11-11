// 模型配置(需求文档 D07.4 规则 1–3、5、6,AC-32):Compute 模型三态继承、Harness 兼容性三时机校验、受影响下游预览、
// 「把模型 X 批量换成 Y」预览与应用、压缩复用说话模型。纯函数:不改入参,返回冻结的新值。
//   - 继承顺序 全局默认 → 联系人 → 单个任务;存储层只存显式覆盖值(联系人的 Compute 槽位 mode=inherit 时不存模型)。
//   - Compute 模型三态:inherit(继承全局 Compute 默认)/ follow-speaking(跟随该联系人的说话模型,只跟模型 id)/ explicit(单独指定)。
//   - effort 跟着各自的槽位走:Compute 槽位给了 effort 就用它,否则用全局默认;跟随说话模型时也只跟模型 id,不跟 effort。
//   - 支持性判据:以能力声明为准(settings.models 里每个模型声明支持哪些 Harness),不按厂商名字猜;
//     声明里没有这个模型记为 undeclared:不拦,但原样用这个模型,绝不替换成 Harness 默认模型(禁止静默换模)。
//   - 不兼容时给两条修复路径:单独指定一个兼容的具体模型 / 更换支持该模型的 Harness。
import { type Vendor, vendorOf } from "./vendor.ts";

export type ComputeSlotMode = "inherit" | "follow-speaking" | "explicit";
export interface ComputeSlot {
  readonly mode: ComputeSlotMode;
  readonly model?: string;
  readonly effort?: string;
}
export interface ModelDefaults {
  readonly harness: string;
  readonly speakingModel: string;
  readonly computeModel: string;
  readonly effort: string;
}
export interface ContactModels {
  readonly id: string;
  readonly name: string;
  readonly speakingModel: string;
  readonly harness: string;
  readonly computeModel: ComputeSlot;
}
/** 单个任务的临时覆盖(派活时的可选参数)。 */
export interface TaskModelOverride {
  readonly model?: string;
  readonly effort?: string;
}
/** 能力声明:这个模型能在哪些 Harness 上跑。 */
export interface ModelCapability {
  readonly id: string;
  readonly harnesses: readonly string[];
}
export type ModelSource = "task" | "explicit" | "follow-speaking" | "global";
export type EffortSource = "task" | "compute-slot" | "global";
export interface ResolvedCompute {
  readonly harness: string;
  readonly model: string;
  readonly effort: string;
  readonly vendor: Vendor;
  readonly modelSource: ModelSource;
  readonly effortSource: EffortSource;
  /** 完整解析链,界面原样显示,例如 ["compute 跟随说话模型", "说话模型 claude-opus-5-5"]。 */
  readonly chain: readonly string[];
}
export type Support = "supported" | "unsupported" | "undeclared";
export type ModelFix =
  | { readonly kind: "explicit-compatible-model"; readonly candidates: readonly string[] }
  | { readonly kind: "change-harness"; readonly candidates: readonly string[] };
export type ComputeCheck =
  | { readonly ok: true; readonly support: "supported" | "undeclared"; readonly resolved: ResolvedCompute }
  | { readonly ok: false; readonly code: "model-incompatible"; readonly reason: string; readonly resolved: ResolvedCompute; readonly fixes: readonly ModelFix[] };

const freeze = <T>(x: T): T => {
  if (x && typeof x === "object" && !Object.isFrozen(x)) {
    for (const v of Object.values(x)) freeze(v);
    Object.freeze(x);
  }
  return x;
};
const nonEmpty = (s: string | undefined): s is string => typeof s === "string" && s.trim() !== "";

/** Compute 生效值:每一轮现场调用,不缓存会话启动时的值(U93)。 */
export function resolveCompute(defaults: ModelDefaults, contact: ContactModels, override?: TaskModelOverride): ResolvedCompute {
  const slot = contact.computeModel;
  const chain: string[] = [];
  let model: string;
  let modelSource: ModelSource;
  if (override && nonEmpty(override.model)) {
    model = override.model;
    modelSource = "task";
    chain.push(`任务单独指定 ${model}`);
  } else if (slot.mode === "explicit" && nonEmpty(slot.model)) {
    model = slot.model;
    modelSource = "explicit";
    chain.push(`compute 单独指定 ${model}`);
  } else if (slot.mode === "follow-speaking") {
    model = contact.speakingModel;
    modelSource = "follow-speaking";
    chain.push("compute 跟随说话模型", `说话模型 ${model}`);
  } else {
    model = defaults.computeModel;
    modelSource = "global";
    chain.push("compute 继承全局", `全局 Compute 默认 ${model}`);
  }
  let effort: string;
  let effortSource: EffortSource;
  if (override && nonEmpty(override.effort)) {
    effort = override.effort;
    effortSource = "task";
  } else if (nonEmpty(slot.effort)) {
    effort = slot.effort;
    effortSource = "compute-slot";
  } else {
    effort = defaults.effort;
    effortSource = "global";
  }
  return freeze({ harness: contact.harness, model, effort, vendor: vendorOf(model), modelSource, effortSource, chain });
}

/** 联系人上下文压缩用的模型:就是这个联系人的说话模型(规则 3),不另设全局杂活模型。 */
export function compressionModel(contact: ContactModels): { readonly model: string; readonly vendor: Vendor } {
  return freeze({ model: contact.speakingModel, vendor: vendorOf(contact.speakingModel) });
}

/** 压缩调用前的同模校验(给压缩流程的调用接口):要发的模型必须就是说话模型;失败重试也不能换成别的模型。 */
export function checkCompressionCall(contact: ContactModels, requestedModel: string): { readonly ok: true } | { readonly ok: false; readonly code: "compression-model-mismatch"; readonly reason: string } {
  const want = contact.speakingModel;
  if (requestedModel === want) return { ok: true };
  return freeze({ ok: false, code: "compression-model-mismatch", reason: `压缩必须用联系人 ${contact.name} 的说话模型 ${want},拒绝改用 ${requestedModel}(失败时保留原文,不换模型)` });
}

// ------------------------------------------------------------------ 说话侧有效配置快照(T-177 G2 = D;AC-32 ③)— 红提交空壳
export interface SpeakingEndpoint {
  readonly provider: string;
  readonly baseUrl: string;
  readonly authRef: string;
  readonly maxOutputTokens: number;
  readonly contextWindow: number;
  readonly reasoning?: Readonly<Record<string, unknown>>;
}
export type EffectiveSpeakingConfig = Readonly<{
  model: string;
  vendor: Vendor;
  provider: string;
  baseUrl: string;
  authRef: string;
  maxOutputTokens: number;
  contextWindow: number;
  reasoning: Readonly<Record<string, unknown>>;
  fingerprint: string;
}>;
export const DEFAULT_SPEAKING_ENDPOINT: SpeakingEndpoint = Object.freeze({ provider: "", baseUrl: "", authRef: "", maxOutputTokens: 0, contextWindow: 0 });
export class SpeakingConfigError extends Error {
  readonly code = "invalid-speaking-config";
}
export function checkSpeakingEndpoint(e: SpeakingEndpoint): SpeakingEndpoint {
  return e;
}
export function speakingFingerprint(_body: Omit<EffectiveSpeakingConfig, "fingerprint">, _bootId: string): string {
  return "";
}
export function resolveSpeakingConfig(_endpoint: SpeakingEndpoint, _model: string, _bootId: string): EffectiveSpeakingConfig {
  return { model: "", vendor: "unknown", provider: "", baseUrl: "", authRef: "", maxOutputTokens: 0, contextWindow: 0, reasoning: {}, fingerprint: "" };
}

export function supportOf(caps: readonly ModelCapability[], harness: string, model: string): Support {
  const decl = caps.find((c) => c.id === model);
  if (!decl) return "undeclared";
  return decl.harnesses.includes(harness) ? "supported" : "unsupported";
}

/** 两条修复路径的候选:能在这个 Harness 上跑的模型 / 能跑这个模型的 Harness(都来自能力声明)。 */
function fixesFor(caps: readonly ModelCapability[], resolved: ResolvedCompute): ModelFix[] {
  const models = caps.filter((c) => c.harnesses.includes(resolved.harness)).map((c) => c.id);
  const harnesses = caps.find((c) => c.id === resolved.model)?.harnesses ?? [];
  return [
    { kind: "explicit-compatible-model", candidates: [...models] },
    { kind: "change-harness", candidates: [...harnesses] },
  ];
}
/** 拦截时给人看的原因:写明 Harness、模型和完整解析链,以及两条修复路径。 */
export function incompatibleReason(resolved: ResolvedCompute): string {
  return `Harness ${resolved.harness} 不支持模型 ${resolved.model}(${resolved.chain.join(" → ")}),本次不启动 Compute;可以单独指定一个兼容的模型,或更换支持该模型的 Harness`;
}

/** 三个时机共用的兼容性判定:不兼容就拦,并给出两条修复路径。 */
export function checkCompute(caps: readonly ModelCapability[], resolved: ResolvedCompute): ComputeCheck {
  const s = supportOf(caps, resolved.harness, resolved.model);
  if (s !== "unsupported") return freeze({ ok: true, support: s, resolved });
  return freeze({ ok: false, code: "model-incompatible", reason: incompatibleReason(resolved), resolved, fixes: fixesFor(caps, resolved) });
}

// ------------------------------------------------------------------ 上游改动预览与批量替换
export type ModelChange =
  | { readonly kind: "defaults"; readonly patch: Partial<ModelDefaults> }
  | { readonly kind: "contact"; readonly contactId: string; readonly patch: Partial<Pick<ContactModels, "speakingModel" | "harness" | "computeModel">> }
  | { readonly kind: "batch-replace"; readonly from: string; readonly to: string };

export type ChangedField = "speaking-model" | "harness" | "compute-model" | "compute-effort";
/** 批量替换里这个联系人是怎么被牵连的:显式引用了 X / 跟着上游变(继承者) */
export type Involvement = "explicit-reference" | "downstream";
export interface AffectedContact {
  readonly contactId: string;
  readonly name: string;
  readonly involvement: Involvement;
  readonly changed: readonly ChangedField[];
  readonly speakingBefore: string;
  readonly speakingAfter: string;
  readonly before: ResolvedCompute;
  readonly after: ResolvedCompute;
  readonly support: Support;
  /** 改完以后这位联系人的 Compute 启动会被拦(不兼容)。 */
  readonly conflict: boolean;
  readonly fixes: readonly ModelFix[];
}
export interface ChangePreview {
  readonly change: ModelChange;
  readonly defaultsBefore: ModelDefaults;
  readonly defaultsAfter: ModelDefaults;
  /** 全局默认里被改到的字段(批量替换时是显式引用了 X 的默认项)。 */
  readonly defaultsChanged: readonly (keyof ModelDefaults)[];
  readonly affected: readonly AffectedContact[];
  readonly conflicts: readonly AffectedContact[];
}
export interface ChangeOutcome {
  readonly preview: ChangePreview;
  readonly defaults: ModelDefaults;
  readonly contacts: readonly ContactModels[];
}

function applyToDefaults(d: ModelDefaults, change: ModelChange): ModelDefaults {
  if (change.kind === "defaults") return { ...d, ...stripUndefined(change.patch) };
  if (change.kind === "batch-replace") {
    return {
      ...d,
      speakingModel: d.speakingModel === change.from ? change.to : d.speakingModel,
      computeModel: d.computeModel === change.from ? change.to : d.computeModel,
    };
  }
  return d;
}
function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
function applyToContact(c: ContactModels, change: ModelChange): { next: ContactModels; explicit: boolean } {
  if (change.kind === "contact") {
    if (change.contactId !== c.id) return { next: c, explicit: false };
    return { next: { ...c, ...stripUndefined(change.patch) }, explicit: true };
  }
  if (change.kind === "batch-replace") {
    const speaks = c.speakingModel === change.from;
    const slot = c.computeModel;
    const pinned = slot.mode === "explicit" && slot.model === change.from;
    if (!speaks && !pinned) return { next: c, explicit: false };
    return {
      next: { ...c, speakingModel: speaks ? change.to : c.speakingModel, computeModel: pinned ? { ...slot, model: change.to } : slot },
      explicit: true,
    };
  }
  return { next: c, explicit: false };
}

/** 保存前预检(时机 ①②):算出改动后每位联系人的生效值,列出所有受影响的下游与冲突;不落盘。 */
export function previewChange(defaults: ModelDefaults, contacts: readonly ContactModels[], caps: readonly ModelCapability[], change: ModelChange): ChangeOutcome {
  const defaultsAfter = applyToDefaults(defaults, change);
  const defaultsChanged = (Object.keys(defaults) as (keyof ModelDefaults)[]).filter((k) => defaults[k] !== defaultsAfter[k]);
  const nextContacts: ContactModels[] = [];
  const affected: AffectedContact[] = [];
  for (const c of contacts) {
    const { next: n, explicit } = applyToContact(c, change);
    const next: ContactModels = { ...n, computeModel: { ...n.computeModel } };
    nextContacts.push(next);
    const before = resolveCompute(defaults, c);
    const after = resolveCompute(defaultsAfter, next);
    const changed: ChangedField[] = [];
    if (c.speakingModel !== next.speakingModel) changed.push("speaking-model");
    if (before.harness !== after.harness) changed.push("harness");
    if (before.model !== after.model) changed.push("compute-model");
    if (before.effort !== after.effort) changed.push("compute-effort");
    if (changed.length === 0 && !explicit) continue;
    const support = supportOf(caps, after.harness, after.model);
    affected.push({
      contactId: c.id,
      name: c.name,
      involvement: explicit ? "explicit-reference" : "downstream",
      changed,
      speakingBefore: c.speakingModel,
      speakingAfter: next.speakingModel,
      before,
      after,
      support,
      conflict: support === "unsupported",
      fixes: support === "unsupported" ? fixesFor(caps, after) : [],
    });
  }
  const preview: ChangePreview = { change: structuredClone(change), defaultsBefore: { ...defaults }, defaultsAfter, defaultsChanged, affected, conflicts: affected.filter((a) => a.conflict) };
  return freeze({ preview, defaults: defaultsAfter, contacts: nextContacts });
}
