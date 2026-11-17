// 兼容门面:界面状态已搬进 zustand store(src/store,按领域切片)。
// 这里保留原来的导出——类型和 useApp()——业务组件的 import 一行不用改。
export type { Answer, CView, Ctx, Page, ScheduleDraft, Section, SplitTab, WbTab } from './store/types'
export { useApp } from './store'
