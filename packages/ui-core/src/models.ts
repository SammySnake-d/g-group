// 模型配置(需求 D07.4 规则 1、2、5、6,U68、U70、U92、U93;验收 R-17、AC-32、AC-51)。
// 纯函数。输入是和 @g-group/api-contract 同形的普通对象:联系人取 ContactView 里的 speakingModel / harness / computeModel,
// 全局取 SettingsView 的 defaultHarness / defaultSpeakingModel / defaultComputeModel / defaultEffort / models。不依赖合同包。
//
// 几条硬规矩:
// - 只在联系人和全局两处配具体模型;Compute 模型槽位三态:继承全局 / 跟随说话模型 / 单独指定。effort 跟着槽位走,没单独设就用全局默认。
// - Harness 支不支持某个模型,只看模型目录里这个模型声明的 harnesses,不按厂商名猜。
// - 不兼容就阻断,给两条修复路径(单独指定一个兼容模型 / 换成支持该模型的 Harness)。任何函数都不返回「自动替换后的模型」。
// - 保存、改上游、启动前三个时机用同一个判定(gateCompute)。
// - 批量替换先出预览,确认后才给变更列表;变更只落在全局默认和联系人配置上,在途任务的启动快照和历史一概不动。

export type SlotMode = "inherit" | "follow-speaking" | "explicit";
export interface ModelSlot { readonly mode: SlotMode; readonly model?: string; readonly effort?: string }
export interface ModelInfo { readonly id: string; readonly label: string; readonly vendor: string; readonly harnesses: readonly string[] }
export interface ModelDefaults {
  readonly defaultHarness: string;
  readonly defaultSpeakingModel: string;
  readonly defaultComputeModel: string;
  readonly defaultEffort: string;
  readonly models: readonly ModelInfo[];
}
export interface ContactModels {
  readonly id: string;
  readonly name: string;
  readonly speakingModel: string;
  readonly harness: string;
  readonly computeModel: ModelSlot;
}

// ---------------------------------------------------------------- 规则 1:生效值与继承链

/** 继承链上的一层。 */
export type Layer = "task" | "contact" | "global";
/**
 * 继承链上的一跳:哪一层的哪个设置,取值是什么。槽位模式这一跳的取值是模式名(inherit / follow-speaking / explicit),
 * effort 没单独设时取值写 inherit;其余是具体值。setting 用合同里的字段名,界面自己翻成人话。
 */
export interface Hop { readonly layer: Layer; readonly setting: string; readonly value: string }
/** 生效值 + 从最具体一层往上找到它的完整路径;最后一跳的取值就是生效值。 */
export interface Resolved { readonly value: string; readonly chain: readonly Hop[] }
export interface ComputeResolution { readonly mode: SlotMode; readonly harness: Resolved; readonly model: Resolved; readonly effort: Resolved }
/** 派活时对单个任务的临时覆盖(继承顺序 全局默认 → 联系人 → 单个任务 的最后一层)。 */
export interface TaskOverride { readonly model?: string; readonly effort?: string }

const hop = (layer: Layer, setting: string, value: string): Hop => ({ layer, setting, value });
const resolved = (chain: Hop[]): Resolved => ({ value: (chain[chain.length - 1] as Hop).value, chain });

/** 联系人说话模型:联系人层不选 Harness(统一用 pi 运行时),只配具体模型。 */
export function resolveSpeaking(c: ContactModels): Resolved {
  return resolved([hop("contact", "speakingModel", c.speakingModel)]);
}

/** Compute 的 Harness、模型、effort 各自的生效值与继承链。每一轮现场解析,不缓存(U93)。 */
export function resolveCompute(c: ContactModels, d: ModelDefaults, task?: TaskOverride): ComputeResolution {
  const slot = c.computeModel;
  const harness = resolved([hop("contact", "harness", c.harness)]);
  let model: Resolved;
  if (task?.model !== undefined) model = resolved([hop("task", "model", task.model)]);
  else if (slot.mode === "inherit") model = resolved([hop("contact", "computeModel.mode", "inherit"), hop("global", "defaultComputeModel", d.defaultComputeModel)]);
  else if (slot.mode === "follow-speaking") model = resolved([hop("contact", "computeModel.mode", "follow-speaking"), hop("contact", "speakingModel", c.speakingModel)]);
  else model = resolved([hop("contact", "computeModel.mode", "explicit"), hop("contact", "computeModel.model", slot.model ?? "")]);
  let effort: Resolved;
  if (task?.effort !== undefined) effort = resolved([hop("task", "effort", task.effort)]);
  else if (slot.effort !== undefined) effort = resolved([hop("contact", "computeModel.effort", slot.effort)]);
  else effort = resolved([hop("contact", "computeModel.effort", "inherit"), hop("global", "defaultEffort", d.defaultEffort)]);
  return { mode: slot.mode, harness, model, effort };
}

// ---------------------------------------------------------------- 规则 2:兼容性(三个时机同一个判定)

/** 不兼容:不替你换模型,只给两条修复路径的候选。 */
export interface Mismatch {
  readonly harness: string;
  readonly model: string;
  /** unsupported:目录里有这个模型,但它没声明支持这个 Harness;unknown-model:目录里没有(含空值)。 */
  readonly reason: "unsupported" | "unknown-model";
  /** 路径一「单独指定一个兼容模型」:这个 Harness 支持的模型,同厂商的排在前面,其余按目录顺序。 */
  readonly compatibleModels: readonly string[];
  /** 路径二「换 Harness」:支持这个模型的 Harness(目录里没有这个模型时为空)。 */
  readonly supportingHarnesses: readonly string[];
}

export const findModel = (id: string, models: readonly ModelInfo[]): ModelInfo | undefined => models.find((m) => m.id === id);
/** 目录里这个模型有没有声明支持这个 Harness(不在目录里的一律不支持)。 */
export function supports(harness: string, model: string, models: readonly ModelInfo[]): boolean {
  return findModel(model, models)?.harnesses.includes(harness) ?? false;
}
/** 模型的原生研发厂商;目录里没有就是 unknown(独立审查门禁据此阻断,不拿配置冒充)。 */
export function vendorOf(model: string, models: readonly ModelInfo[]): string {
  return findModel(model, models)?.vendor ?? "unknown";
}

/** 某个 Harness 能不能跑某个模型。兼容返回 null。 */
export function checkCompat(harness: string, model: string, models: readonly ModelInfo[]): Mismatch | null {
  if (supports(harness, model, models)) return null;
  const info = findModel(model, models);
  const others = models.filter((m) => m.id !== model && supports(harness, m.id, models));
  const vendor = info?.vendor;
  const compatibleModels = [...others.filter((m) => m.vendor === vendor), ...others.filter((m) => m.vendor !== vendor)].map((m) => m.id);
  return { harness, model, reason: info ? "unsupported" : "unknown-model", compatibleModels, supportingHarnesses: info ? [...info.harnesses] : [] };
}

/** 三个检查时机:保存配置时、改上游(全局默认 / 说话模型 / Harness / 批量替换)时、Compute 启动前。 */
export type Moment = "save" | "upstream" | "launch";
export interface Gate {
  readonly moment: Moment;
  readonly contactId: string;
  /** 不兼容时为 false:保存不可用、启动被拦下。 */
  readonly allowed: boolean;
  /** 被检查的就是这组生效值本身,不兼容时也原样返回,不换成别的模型。 */
  readonly compute: ComputeResolution;
  readonly mismatch: Mismatch | null;
  /** 联系人本体说话不受 Compute 失配影响,照常用这个模型。 */
  readonly speaking: Resolved;
}

/** 三个时机共用的唯一判定。moment 只标记是哪个时机,判定逻辑完全相同。 */
export function gateCompute(moment: Moment, c: ContactModels, d: ModelDefaults, task?: TaskOverride): Gate {
  const compute = resolveCompute(c, d, task);
  const mismatch = checkCompat(compute.harness.value, compute.model.value, d.models);
  return { moment, contactId: c.id, allowed: mismatch === null, compute, mismatch, speaking: resolveSpeaking(c) };
}

/** 全局默认组合自己(默认 Harness + 默认 Compute 模型)是否成立:新建联系人「只填 Soul 就能跑」的前提。 */
export function checkDefaults(d: ModelDefaults): Mismatch | null {
  return checkCompat(d.defaultHarness, d.defaultComputeModel, d.models);
}

/** 任务启动时写下的不可变快照(规则 5:initial_model_snapshot)。拿不到厂商的记 unknown。 */
export interface ModelSnapshot { readonly harness: string; readonly model: string; readonly effort: string; readonly vendor: string }
export type LaunchResult = { readonly ok: true; readonly snapshot: ModelSnapshot } | { readonly ok: false; readonly gate: Gate };

/** Compute 启动前:先过同一个判定,不兼容就不启动、不出快照;兼容才按生效值写快照。 */
export function launchSnapshot(c: ContactModels, d: ModelDefaults, task?: TaskOverride): LaunchResult {
  const gate = gateCompute("launch", c, d, task);
  if (!gate.allowed) return { ok: false, gate };
  const g = gate.compute;
  return { ok: true, snapshot: Object.freeze({ harness: g.harness.value, model: g.model.value, effort: g.effort.value, vendor: vendorOf(g.model.value, d.models) }) };
}

export type Field = "harness" | "model" | "effort";
const FIELDS: readonly Field[] = ["harness", "model", "effort"];
const diffFields = (a: { readonly [K in Field]: string }, b: { readonly [K in Field]: string }): Field[] => FIELDS.filter((f) => a[f] !== b[f]);
const valuesOf = (r: ComputeResolution): { readonly [K in Field]: string } => ({ harness: r.harness.value, model: r.model.value, effort: r.effort.value });

/**
 * 「按当前配置会用什么」和「这次任务实际用了什么」分开(规则 5)。传了任务快照就以快照为准显示实际值,
 * 配置改过的字段列进 drift(下一轮按新配置走,U93),快照本身原样返回、不追溯。
 */
export interface TaskModels { readonly shown: "snapshot" | "config"; readonly actual: ModelSnapshot | null; readonly planned: ComputeResolution; readonly drift: readonly Field[] }
export function taskModels(snapshot: ModelSnapshot | null, c: ContactModels, d: ModelDefaults): TaskModels {
  const planned = resolveCompute(c, d);
  if (!snapshot) return { shown: "config", actual: null, planned, drift: [] };
  return { shown: "snapshot", actual: snapshot, planned, drift: diffFields(snapshot, valuesOf(planned)) };
}

// ---------------------------------------------------------------- 修复路径与改全局默认的影响

/** 用户点的修复:路径一「单独指定兼容模型」= pin-model;路径二「换 Harness」= switch-harness。 */
export type Fix =
  | { readonly kind: "pin-model"; readonly contactId: string; readonly model: string }
  | { readonly kind: "switch-harness"; readonly contactId: string; readonly harness: string };

/** 把用户选的修复落到联系人配置上(不改入参)。pin-model 保留原来的 effort。id 对不上的修复不生效。 */
export function applyFix(c: ContactModels, fix: Fix): ContactModels {
  if (fix.contactId !== c.id) return c;
  if (fix.kind === "switch-harness") return { ...c, harness: fix.harness };
  const effort = c.computeModel.effort;
  return { ...c, computeModel: effort === undefined ? { mode: "explicit", model: fix.model } : { mode: "explicit", model: fix.model, effort } };
}

/**
 * 给一处失配推荐两条修复(各最多一条,没有可行的就不给):
 * 路径一优先「保持原来那个模型」(它在这个 Harness 上兼容时),否则取兼容候选的第一个;路径二取支持该模型的第一个 Harness。
 */
export function suggestFixes(contactId: string, m: Mismatch, previousModel?: string): Fix[] {
  const out: Fix[] = [];
  const keep = previousModel !== undefined && previousModel !== m.model && m.compatibleModels.includes(previousModel) ? previousModel : m.compatibleModels[0];
  if (keep !== undefined) out.push({ kind: "pin-model", contactId, model: keep });
  const h = m.supportingHarnesses[0];
  if (h !== undefined) out.push({ kind: "switch-harness", contactId, harness: h });
  return out;
}

export interface Impact {
  readonly contactId: string;
  readonly name: string;
  /** 下一轮生效值变了的字段。 */
  readonly changed: readonly Field[];
  readonly before: ComputeResolution;
  readonly after: ComputeResolution;
  readonly mismatch: Mismatch | null;
  /** 失配时推荐的两条修复(改之前的模型作为「保持原来」的候选)。 */
  readonly fixes: readonly Fix[];
}
export interface DefaultsPlan {
  /** 改完之后下一轮生效值会变的联系人(继承全局的那些,加上被修复改过的)。 */
  readonly affected: readonly Impact[];
  /** 其中会变成不兼容的。 */
  readonly mismatched: readonly Impact[];
  /** 新的全局默认组合本身不兼容。 */
  readonly defaultsMismatch: Mismatch | null;
  /** 改了但已有联系人都不读的全局项(每个联系人都存了自己的说话模型和 Harness),只影响之后新建的联系人。 */
  readonly newContactsOnly: readonly ("defaultHarness" | "defaultSpeakingModel")[];
  /** 应用了修复之后的联系人配置(只列被修复改过的),保存时一起写。 */
  readonly patched: readonly ContactModels[];
  readonly canSave: boolean;
}

/** 改全局默认的预检(规则 2 时机②):保存前列出受影响的下游联系人和其中会变成不兼容的;有失配就不能保存。 */
export function planDefaults(contacts: readonly ContactModels[], before: ModelDefaults, after: ModelDefaults, fixes: readonly Fix[] = []): DefaultsPlan {
  const affected: Impact[] = [];
  const patched: ContactModels[] = [];
  for (const c of contacts) {
    const fixed = fixes.reduce(applyFix, c);
    if (fixed !== c) patched.push(fixed);
    const b = resolveCompute(c, before);
    const a = resolveCompute(fixed, after);
    const changed = diffFields(valuesOf(b), valuesOf(a));
    if (!changed.length) continue;
    const mismatch = checkCompat(a.harness.value, a.model.value, after.models);
    affected.push({ contactId: c.id, name: c.name, changed, before: b, after: a, mismatch, fixes: mismatch ? suggestFixes(c.id, mismatch, b.model.value) : [] });
  }
  const mismatched = affected.filter((x) => x.mismatch !== null);
  const defaultsMismatch = checkDefaults(after);
  const newContactsOnly = (["defaultHarness", "defaultSpeakingModel"] as const).filter((k) => before[k] !== after[k]);
  return { affected, mismatched, defaultsMismatch, newContactsOnly, patched, canSave: mismatched.length === 0 && defaultsMismatch === null };
}

// ---------------------------------------------------------------- U93:改了下一轮生效

export interface NextTurn {
  readonly speaking: boolean;
  readonly compute: readonly Field[];
  /** 换 Harness 不是换模型 id:下一轮在新 Harness 上开新会话,宿主带上下文过去(D27 第 5 节)。 */
  readonly harnessSwitch: boolean;
  /** 正在跑、不被打断的轮次数(按启动时的模型跑完)。 */
  readonly running: number;
}
/** 联系人配置改了以后,下一轮会有什么不同。生效值都没变就返回 null(不需要提示)。 */
export function nextTurn(before: ContactModels, after: ContactModels, d: ModelDefaults, running: number): NextTurn | null {
  const speaking = resolveSpeaking(before).value !== resolveSpeaking(after).value;
  const compute = diffFields(valuesOf(resolveCompute(before, d)), valuesOf(resolveCompute(after, d)));
  if (!speaking && !compute.length) return null;
  return { speaking, compute, harnessSwitch: compute.includes("harness"), running: Math.max(0, Math.trunc(running)) };
}

// ---------------------------------------------------------------- 规则 6:把模型 X 批量换成 Y

export type RefField = "defaultSpeakingModel" | "defaultComputeModel" | "speakingModel" | "computeModel.model";
/** 直接写了 X 的地方。contactId 为 null 表示全局默认。 */
export interface ModelRef { readonly contactId: string | null; readonly field: RefField }
/** 自己没写 X、通过继承用到 X 的联系人。 */
export interface Inheritor { readonly contactId: string; readonly via: "inherit" | "follow-speaking" }
/** 一处兼容冲突。fixes 是推荐的两条修复(全局默认那一处的 contactId 用 DEFAULTS_KEY),界面按它生成 Resolution。 */
export interface ReplaceConflict { readonly contactId: string | null; readonly mismatch: Mismatch; readonly fixes: readonly Fix[] }
/**
 * 用户对一处冲突的处理。keep:这一位单独指定一个兼容模型(通常就是 X 本身,对全局默认就是默认 Compute 模型改成它);
 * harness:换成支持 Y 的 Harness。
 */
export type Resolution = { readonly kind: "keep"; readonly model: string } | { readonly kind: "harness"; readonly harness: string };
/** 全局默认在 resolutions 里的键。 */
export const DEFAULTS_KEY = "@defaults";
export interface ReplaceInput {
  readonly contacts: readonly ContactModels[];
  readonly defaults: ModelDefaults;
  readonly from: string;
  readonly to: string;
  /** 在途任务:只读它们的启动快照用来提示「不改」。 */
  readonly tasks?: readonly { readonly id: string; readonly model: string }[];
  readonly resolutions?: Readonly<Record<string, Resolution>>;
}
export interface ReplacePlan {
  readonly from: string;
  readonly to: string;
  /** 输入本身不成立(目标模型不在目录里、X 与 Y 相同)。 */
  readonly problem: string | null;
  readonly explicit: readonly ModelRef[];
  readonly inheritors: readonly Inheritor[];
  /** 还没处理的兼容冲突;有就不能确认。 */
  readonly conflicts: readonly ReplaceConflict[];
  /** 已按用户选择处理掉的冲突(联系人 id,全局默认为 DEFAULTS_KEY)。 */
  readonly resolved: readonly string[];
  /** 单独指定成别的模型的联系人:不会被误改。 */
  readonly pinnedElsewhere: readonly string[];
  /** 启动快照里是 X 的在途任务:快照和历史都不改。 */
  readonly inFlight: readonly string[];
  readonly canConfirm: boolean;
}
/** 确认后给出的一条变更。contactId 为 null 表示全局默认;只会落在全局默认和联系人配置上。 */
export interface Change { readonly contactId: string | null; readonly field: string; readonly from: string; readonly to: string }

interface Simulated {
  plan: ReplacePlan;
  defaultsAfter: ModelDefaults;
  contactsAfter: ContactModels[];
}

function simulateReplace(input: ReplaceInput): Simulated {
  const { contacts, defaults: d, from, to } = input;
  const res = input.resolutions ?? {};
  const problem = from === to ? "要换的两个模型是同一个" : !findModel(to, d.models) ? `模型目录里没有 ${to}` : null;
  const swap = (v: string) => (v === from ? to : v);
  const explicit: ModelRef[] = [];
  if (d.defaultSpeakingModel === from) explicit.push({ contactId: null, field: "defaultSpeakingModel" });
  if (d.defaultComputeModel === from) explicit.push({ contactId: null, field: "defaultComputeModel" });

  // 全局默认:先按原样替换,再看用户对全局默认冲突的处理
  let defaultsAfter: ModelDefaults = { ...d, defaultSpeakingModel: swap(d.defaultSpeakingModel), defaultComputeModel: swap(d.defaultComputeModel) };
  const conflicts: ReplaceConflict[] = [];
  const resolved: string[] = [];
  if (d.defaultComputeModel === from) {
    const m0 = checkDefaults(defaultsAfter);
    if (m0) {
      const r = res[DEFAULTS_KEY];
      if (r) defaultsAfter = r.kind === "keep" ? { ...defaultsAfter, defaultComputeModel: r.model } : { ...defaultsAfter, defaultHarness: r.harness };
      const m1 = r ? checkDefaults(defaultsAfter) : m0;
      if (m1) conflicts.push({ contactId: null, mismatch: m1, fixes: suggestFixes(DEFAULTS_KEY, m1, d.defaultComputeModel) });
      else resolved.push(DEFAULTS_KEY);
    }
  }

  const inheritors: Inheritor[] = [];
  const pinnedElsewhere: string[] = [];
  const contactsAfter: ContactModels[] = [];
  for (const c of contacts) {
    const slot = c.computeModel;
    if (c.speakingModel === from) explicit.push({ contactId: c.id, field: "speakingModel" });
    if (slot.mode === "explicit" && slot.model === from) explicit.push({ contactId: c.id, field: "computeModel.model" });
    if (slot.mode === "explicit" && slot.model !== from) pinnedElsewhere.push(c.id);
    const before = resolveCompute(c, d);
    if (slot.mode !== "explicit" && before.model.value === from) inheritors.push({ contactId: c.id, via: slot.mode });

    let after: ContactModels = { ...c, speakingModel: swap(c.speakingModel), computeModel: slot.mode === "explicit" && slot.model !== undefined ? { ...slot, model: swap(slot.model) } : slot };
    const a0 = resolveCompute(after, defaultsAfter);
    const moved = diffFields(valuesOf(before), valuesOf(a0)).length > 0;
    const m0 = moved ? checkCompat(a0.harness.value, a0.model.value, d.models) : null;
    if (m0) {
      const r = res[c.id];
      if (r) after = r.kind === "keep" ? applyFix(after, { kind: "pin-model", contactId: c.id, model: r.model }) : applyFix(after, { kind: "switch-harness", contactId: c.id, harness: r.harness });
      const a1 = resolveCompute(after, defaultsAfter);
      const m1 = r ? checkCompat(a1.harness.value, a1.model.value, d.models) : m0;
      if (m1) conflicts.push({ contactId: c.id, mismatch: m1, fixes: suggestFixes(c.id, m1, before.model.value) });
      else resolved.push(c.id);
    }
    contactsAfter.push(after);
  }
  const inFlight = (input.tasks ?? []).filter((t) => t.model === from).map((t) => t.id);
  const canConfirm = problem === null && conflicts.length === 0 && explicit.length > 0;
  return { plan: { from, to, problem, explicit, inheritors, conflicts, resolved, pinnedElsewhere, inFlight, canConfirm }, defaultsAfter, contactsAfter };
}

/** 预览:显式引用、下游继承者、兼容冲突、不会被误改的、在途不改的。不产生任何变更。 */
export function planReplace(input: ReplaceInput): ReplacePlan {
  return simulateReplace(input).plan;
}

const slotFields = (s: ModelSlot): Record<string, string> => ({ "computeModel.mode": s.mode, "computeModel.model": s.model ?? "", "computeModel.effort": s.effort ?? "" });

/** 确认:预览成立(没有未处理的冲突)才生成变更列表;否则拒绝并把冲突带回去。 */
export function confirmReplace(input: ReplaceInput): { readonly ok: true; readonly changes: readonly Change[] } | { readonly ok: false; readonly reason: string; readonly conflicts: readonly ReplaceConflict[] } {
  const { plan, defaultsAfter, contactsAfter } = simulateReplace(input);
  if (!plan.canConfirm) {
    const reason = plan.problem ?? (plan.conflicts.length ? `还有 ${plan.conflicts.length} 处兼容冲突没处理` : `没有地方直接用了 ${plan.from}`);
    return { ok: false, reason, conflicts: plan.conflicts };
  }
  const changes: Change[] = [];
  const d = input.defaults;
  for (const k of ["defaultHarness", "defaultSpeakingModel", "defaultComputeModel"] as const) {
    if (d[k] !== defaultsAfter[k]) changes.push({ contactId: null, field: k, from: d[k], to: defaultsAfter[k] });
  }
  input.contacts.forEach((c, i) => {
    const a = contactsAfter[i] as ContactModels;
    if (c.speakingModel !== a.speakingModel) changes.push({ contactId: c.id, field: "speakingModel", from: c.speakingModel, to: a.speakingModel });
    if (c.harness !== a.harness) changes.push({ contactId: c.id, field: "harness", from: c.harness, to: a.harness });
    const sb = slotFields(c.computeModel);
    const sa = slotFields(a.computeModel);
    for (const f of Object.keys(sb)) if (sb[f] !== sa[f]) changes.push({ contactId: c.id, field: f, from: sb[f] as string, to: sa[f] as string });
  });
  return { ok: true, changes };
}

// ---------------------------------------------------------------- U92:卡死判定阈值(D26 第 8.6 节,#2827)

/** 默认:一轮 15 分钟无进展判失败;模型调用发出后等首字节 120 秒。 */
export const STALL_DEFAULTS: Readonly<{ turnMinutes: number; firstByteSeconds: number }> = Object.freeze({ turnMinutes: 15, firstByteSeconds: 120 });
/** 按联系人单独设的值;没设的项用默认。 */
export interface StallOverride { readonly turnMinutes?: number; readonly firstByteSeconds?: number }
export interface StallValue { readonly value: number; readonly source: "default" | "contact" }
export function resolveStall(o?: StallOverride): { readonly turnMinutes: StallValue; readonly firstByteSeconds: StallValue } {
  const pick = (v: number | undefined, dflt: number): StallValue => (v === undefined ? { value: dflt, source: "default" } : { value: v, source: "contact" });
  return { turnMinutes: pick(o?.turnMinutes, STALL_DEFAULTS.turnMinutes), firstByteSeconds: pick(o?.firstByteSeconds, STALL_DEFAULTS.firstByteSeconds) };
}
/** 单独设的阈值是否成立:正整数,整轮不超过一天,首字节窗口要短于整轮阈值。成立返回 null,否则返回原因。 */
export function checkStall(o: StallOverride): string | null {
  const r = resolveStall(o);
  const t = r.turnMinutes.value;
  const f = r.firstByteSeconds.value;
  if (!Number.isInteger(t) || t < 1) return "整轮无进展的阈值要是正整数分钟";
  if (t > 1440) return "整轮无进展的阈值不能超过 1440 分钟(一天)";
  if (!Number.isInteger(f) || f < 1) return "等首字节的时间要是正整数秒";
  if (f >= t * 60) return `等首字节的时间要短于整轮阈值(${t} 分钟 = ${t * 60} 秒)`;
  return null;
}
