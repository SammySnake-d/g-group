// 子路径入口 @g-group/adapter-cc-compute/resident:常驻 Compute 适配器与轮边界换模型计划(AC-51、需求文档 D27)。
export { DEFAULT_SWITCH_TIMEOUT_MS, createResidentComputeAdapter, residentArgs, turnModels } from "./resident.ts";
export type { ResidentAdapterOptions } from "./resident.ts";
export { checkTurnModel, planTurn, switchRefusalKind } from "./turn-model.ts";
export type { SessionModel, SwitchCapabilities, TurnStep } from "./turn-model.ts";
