import { SplitPane } from '@/components/Split'
import { useApp } from '@/store'
import { Divider } from './Divider'

/** 右侧分栏:多页签(Compute、文件、联系人、定时、群资料),可调宽 */
export function SplitArea() {
  const { tabs, tabIdx, width, pickTab, closeTab, closeTabs, resize } = useApp((s) => ({ tabs: s.tabs, tabIdx: s.tabIdx, width: s.widths.split, pickTab: s.pickTab, closeTab: s.closeTab, closeTabs: s.closeTabs, resize: s.resize }))
  if (!tabs.length) return null
  return (
    <>
      <Divider testid="div-split" onDrag={(dx) => resize('split', -dx)} />
      <SplitPane width={width} tabs={tabs} active={Math.min(tabIdx, tabs.length - 1)} onPick={pickTab} onClose={closeTab} onCloseAll={closeTabs} />
    </>
  )
}
