// 兼容门面:界面状态已搬进 zustand store(src/store,按领域切片)。
export type { Answer, CView, Ctx, Page, ScheduleDraft, Section, SplitTab, WbTab } from './store/types'
export { useApp } from './store'
