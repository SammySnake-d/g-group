import type { BoardFilter } from '@g-group/ui-core'

/** 关掉再开,筛选、展开和滚动位置都还在(U83 实现要求;mirasim 把它们放在看板 store 里)。看板随遮罩卸载,所以记在模块里 */
export interface PanelMemory { filter: BoardFilter; unfolded: Set<string>; scroll: { top: number; left: number } }

export const panelMemory: PanelMemory = {
  filter: { groupBy: 'room', bucket: 'all', range: '7d', query: '' },
  unfolded: new Set(),
  scroll: { top: 0, left: 0 },
}
