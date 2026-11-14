// 子路径入口 @g-group/adapter-cc-compute/resident:常驻 Compute 适配器与轮边界换模型计划(AC-51、需求文档 D27)。
// 不从包根导出运行时函数:包根的导出函数清单由 adapter.test.ts 的 R6-01 表逐个核对,常驻适配器另走这个入口;
// 本入口的每个函数同样先按纯数据合同判定外部输入(plain.ts)。类型(TurnModel、AdapterCapabilities 等)仍在包根 types.ts。
export { DEFAULT_SWITCH_TIMEOUT_MS, createResidentComputeAdapter, residentArgs, turnModels } from "./resident.ts";
export type { ResidentAdapterOptions } from "./resident.ts";
export { checkTurnModel, planTurn, switchRefusalKind } from "./turn-model.ts";
export type { SessionModel, SwitchCapabilities, TurnStep } from "./turn-model.ts";
