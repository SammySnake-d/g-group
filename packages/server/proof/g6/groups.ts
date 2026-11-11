// G6 四组对照的定义与开关表(方案 §9):①当前基线;②G1+G2(v0.2 缺陷 1–6);③再加 G5 两段式;④再加 G4 历史查询(v3.28 D06:
// 红提交空壳:签名在、返回假值(undefined),实现见下一个提交。
// 一个内置查询工具,检索与分页回读两种用法)与宿主预取,另做预取开/关消融。
// G3 检索是③④的共同底座:进了③就已经换掉旧的 overlap 排序,不能把③④当旧算法比。
// 一组能不能跑由机械条件定:每个要叠加的片都能解析到提交,且该提交里有本片收据(pstack 收据提交在绿与变异之后)。
import type { HostPatch } from "./types.ts";

export type SwitchKey = "g1" | "g2" | "g3" | "g5" | "g4" | "prefetch";
export const SWITCHES: readonly { readonly key: SwitchKey; readonly title: string }[] = Object.freeze([
  { key: "g1", title: "覆盖台账·逐条来源·失败判定(G1)" },
  { key: "g2", title: "统一配置快照(G2)" },
  { key: "g3", title: "BC 检索排序(G3,③④共同底座)" },
  { key: "g5", title: "两段式粗筛/精筛(G5)" },
  { key: "g4", title: "历史查询工具:检索+分页回读(G4,一个内置工具)" },
  { key: "prefetch", title: "宿主预取(G4)" },
]);
export const SLICE_BRANCHES: Readonly<Record<string, string>> = Object.freeze({
  G1: "feat/t177-g1-memory",
  G2: "feat/t177-g2-config",
  G3: "feat/t177-g3-bc-search",
  G4: "feat/t177-g4-history-tools",
  G5: "feat/t177-g5-two-stage",
});
/** 方案 §9 的①:当前基线 dev/integration。 */
export const BASELINE = "4efdee0be6d161060099b5ce488e3344c70305ee";

export interface GroupDef {
  readonly id: string;
  readonly label: string;
  /** 在基线上按顺序合入的片 */
  readonly slices: readonly string[];
  readonly switches: Readonly<Record<SwitchKey, boolean>>;
  /** 本组的宿主选项覆盖(被测提交自己已有、start.ts 不暴露的选项,如预取开关、G5 精筛安静期);null 不改 */
  readonly hostPatch: HostPatch | null;
  /** 本组每题最后留给后台工作(补查、精筛)的时间;null 用命令行的 --settle */
  readonly settleMs: number | null;
  /** 与分支无关、本组暂时跑不了的原因;null 表示没有 */
  readonly blocked: string | null;
}
const sw = (on: readonly SwitchKey[]): Record<SwitchKey, boolean> => undefined as never;
/**
 * G5 精筛的安静期默认 5 分钟(kernel DEFAULT_FINE_SCREEN,待校准占位)。一道题只有一两分钟,按默认值精筛在题内永远不触发,
 * 所以含 G5 的组把安静期调到 20 秒、每题末尾留 35 秒给精筛;这是 G6 的实验参数,进配置指纹和报告,不是产品定值。
 */
export const G6_FINE_SCREEN = Object.freeze({ quietMs: 20_000 });
export const G6_FINE_SETTLE_MS = 35_000;
export const GROUPS: readonly GroupDef[] = Object.freeze([
  { id: "g1", label: "①当前基线", slices: [], switches: sw([]), hostPatch: null, settleMs: null, blocked: null },
  { id: "g2", label: "②G1+G2", slices: ["G1", "G2"], switches: sw(["g1", "g2"]), hostPatch: null, settleMs: null, blocked: null },
  { id: "g3", label: "③②+G5 两段式(含 G3 检索底座)", slices: ["G1", "G2", "G3", "G5"], switches: sw(["g1", "g2", "g3", "g5"]), hostPatch: { fineScreen: G6_FINE_SCREEN }, settleMs: G6_FINE_SETTLE_MS, blocked: null },
  { id: "g4on", label: "④③+G4 历史查询,预取开", slices: ["G1", "G2", "G3", "G5", "G4"], switches: sw(["g1", "g2", "g3", "g5", "g4", "prefetch"]), hostPatch: { fineScreen: G6_FINE_SCREEN }, settleMs: G6_FINE_SETTLE_MS, blocked: null },
  { id: "g4off", label: "④消融:预取关", slices: ["G1", "G2", "G3", "G5", "G4"], switches: sw(["g1", "g2", "g3", "g5", "g4"]), hostPatch: { fineScreen: G6_FINE_SCREEN, opts: { historyPrefetch: false } }, settleMs: G6_FINE_SETTLE_MS, blocked: null },
]);

export const receiptPath = (branch: string): string => undefined as never;

/** runner 用到的 git 查询(真实实现跑 git,测试注入假的)。 */
export interface GitQuery {
  revParse(ref: string): string | null;
  hasFile(commit: string, file: string): boolean;
  /** a 是不是 b 的祖先(或同一个提交) */
  isAncestor(a: string, b: string): boolean;
}
export interface SliceInput {
  readonly slice: string;
  readonly branch: string;
  readonly ref: string | null;
  readonly sha: string | null;
  readonly receipt: boolean;
}
export type GroupStateKind = "可跑" | "未测(分支未就绪)" | "未测(开关未定)" | "未测(合入冲突)";
export interface GroupState {
  readonly id: string;
  readonly label: string;
  readonly state: GroupStateKind;
  readonly reason: string | null;
  readonly base: string | null;
  readonly inputs: readonly SliceInput[];
  /** 现成的组提交(只供 G6 的合并提交,`--group-ref`);有它就直接用,不再按序合入 */
  readonly groupCommit: string | null;
}

/** 一片取哪个提交:显式覆盖优先;否则远端分支、本地分支里有本片收据的那个(都有取远端)。 */
export function resolveSlice(slice: string, git: GitQuery, overrides: Readonly<Record<string, string>> = {}): SliceInput { return undefined as never; }

/**
 * 一组的状态。groupRefs[组 id] 给了现成的组提交时:它必须包含基线和每一片的当前提交(祖先关系),且里面有每一片的收据,
 * 否则记未测并写明缺哪片——组提交不能悄悄换掉某一片。
 */
export function resolveGroup(def: GroupDef, git: GitQuery, o: { base?: string; overrides?: Readonly<Record<string, string>>; groupRefs?: Readonly<Record<string, string>> } = {}): GroupState { return undefined as never; }

/** 开关表(markdown)。G3 一列的说明必须出现:它是③④的共同底座。 */
export function switchTable(groups: readonly GroupDef[] = GROUPS): string { return undefined as never; }
