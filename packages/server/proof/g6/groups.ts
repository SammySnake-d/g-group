// G6 四组对照的定义与开关表(方案 §9):①当前基线;②G1+G2(v0.2 缺陷 1–6);③再加 G5 两段式;④再加 G4 历史查询(v3.28 D06:
// 红提交空壳:签名在、返回假值(undefined),实现见下一个提交。
// 一个内置查询工具,检索与分页回读两种用法)与宿主预取,另做预取开/关消融。
// G3 检索是③④的共同底座:进了③就已经换掉旧的 overlap 排序,不能把③④当旧算法比。
// 一组能不能跑由机械条件定:每个要叠加的片都能解析到提交,且该提交里有本片收据(pstack 收据提交在绿与变异之后)。
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
  /** 本组启动后给宿主的设置补丁(被测提交自己的开关,如预取);null 不改 */
  readonly settings: Readonly<Record<string, unknown>> | null;
  /** 与分支无关、本组暂时跑不了的原因;null 表示没有 */
  readonly blocked: string | null;
}
const sw = (on: readonly SwitchKey[]): Record<SwitchKey, boolean> => undefined as never;
export const GROUPS: readonly GroupDef[] = Object.freeze([
  { id: "g1", label: "①当前基线", slices: [], switches: sw([]), settings: null, blocked: null },
  { id: "g2", label: "②G1+G2", slices: ["G1", "G2"], switches: sw(["g1", "g2"]), settings: null, blocked: null },
  { id: "g3", label: "③②+G5 两段式(含 G3 检索底座)", slices: ["G1", "G2", "G3", "G5"], switches: sw(["g1", "g2", "g3", "g5"]), settings: null, blocked: null },
  { id: "g4on", label: "④③+G4 历史查询,预取开", slices: ["G1", "G2", "G3", "G5", "G4"], switches: sw(["g1", "g2", "g3", "g5", "g4", "prefetch"]), settings: null, blocked: null },
  { id: "g4off", label: "④消融:预取关", slices: ["G1", "G2", "G3", "G5", "G4"], switches: sw(["g1", "g2", "g3", "g5", "g4"]), settings: null, blocked: "G4 的预取开关接口未定:G4 落地后在本组 settings 填它的设置名再跑" },
]);

export const receiptPath = (branch: string): string => undefined as never;

/** runner 用到的 git 查询(真实实现跑 git,测试注入假的)。 */
export interface GitQuery {
  revParse(ref: string): string | null;
  hasFile(commit: string, file: string): boolean;
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
}

/** 一片取哪个提交:显式覆盖优先;否则远端分支、本地分支里有本片收据的那个(都有取远端)。 */
export function resolveSlice(slice: string, git: GitQuery, overrides: Readonly<Record<string, string>> = {}): SliceInput { return undefined as never; }

export function resolveGroup(def: GroupDef, git: GitQuery, o: { base?: string; overrides?: Readonly<Record<string, string>> } = {}): GroupState { return undefined as never; }

/** 开关表(markdown)。G3 一列的说明必须出现:它是③④的共同底座。 */
export function switchTable(groups: readonly GroupDef[] = GROUPS): string { return undefined as never; }
