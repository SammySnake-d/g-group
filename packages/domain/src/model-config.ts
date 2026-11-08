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

// 空壳(红):签名在,返回假值。
export function resolveCompute(_defaults: ModelDefaults, _contact: ContactModels, _override?: TaskModelOverride): ResolvedCompute {
  return { harness: "", model: "", effort: "", vendor: vendorOf(undefined), modelSource: "global", effortSource: "global", chain: [] };
}
export function compressionModel(_contact: ContactModels): { readonly model: string; readonly vendor: Vendor } {
  return { model: "", vendor: "unknown" };
}
export function checkCompressionCall(_contact: ContactModels, _requestedModel: string): { readonly ok: true } | { readonly ok: false; readonly code: "compression-model-mismatch"; readonly reason: string } {
  return { ok: false, code: "compression-model-mismatch", reason: "" };
}
export function supportOf(_caps: readonly ModelCapability[], _harness: string, _model: string): Support {
  return "undeclared";
}
export function checkCompute(_caps: readonly ModelCapability[], resolved: ResolvedCompute): ComputeCheck {
  return { ok: true, support: "undeclared", resolved };
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

export function previewChange(defaults: ModelDefaults, contacts: readonly ContactModels[], _caps: readonly ModelCapability[], change: ModelChange): ChangeOutcome {
  return { preview: { change, defaultsBefore: defaults, defaultsAfter: defaults, defaultsChanged: [], affected: [], conflicts: [] }, defaults, contacts };
}
