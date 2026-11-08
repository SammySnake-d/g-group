/* 插件中心（用户 #719：要有插件市场和安装入口）。
   左边是自己的一栏：发现 / 已安装 / 有更新 + 类别；右边是卡片网格或详情页。安装 / 更新 / 卸载的对话框由 usePluginFlow 统一弹。 */
import { useMemo, useState } from 'react'
import { marketCounts, type MarketSort, type PluginCategory } from '@g-group/ui-core'
import { useApp } from '@/ctx'
import { CenterNav } from './CenterNav'
import { TAB_LABEL, type PluginTab } from './constants'
import { Discover } from './Discover'
import { usePluginFlow } from './flow'
import { Installed } from './Installed'
import { PluginDetail } from './PluginDetail'
import { SideloadDialog } from './SideloadDialog'
import { Updates } from './Updates'
import { takeDetailIntent } from './util'

export function PluginCenter() {
  const { plugins, pluginCatalog } = useApp()
  const [tab, setTab] = useState<PluginTab>('discover')
  const [detail, setDetail] = useState<string | null>(takeDetailIntent)
  const [text, setText] = useState('')
  const [cat, setCat] = useState<PluginCategory | 'all'>('all')
  const [sort, setSort] = useState<MarketSort>('featured')
  const [sideload, setSideload] = useState(false)
  const flow = usePluginFlow()
  const counts = useMemo(() => marketCounts(pluginCatalog, plugins), [pluginCatalog, plugins])
  const go = (t: PluginTab) => { setTab(t); setDetail(null) }
  return (
    <div data-testid="plugin-center" className="flex min-w-0 flex-1">
      <CenterNav tab={tab} inDetail={!!detail} cat={cat} counts={counts} onTab={go} onCat={(c) => { setCat(c); go('discover') }} onSideload={() => setSideload(true)} />
      <main className="scroll-thin min-w-0 flex-1 overflow-y-auto">
        {detail ? <PluginDetail key={detail} id={detail} flow={flow} onBack={() => setDetail(null)} backLabel={TAB_LABEL[tab]} />
          : tab === 'discover' ? <Discover text={text} setText={setText} cat={cat} sort={sort} setSort={setSort} flow={flow} open={setDetail} onSideload={() => setSideload(true)} />
          : tab === 'installed' ? <Installed flow={flow} open={setDetail} onDiscover={() => go('discover')} />
          : <Updates flow={flow} open={setDetail} />}
      </main>
      {flow.dialogs}
      <SideloadDialog open={sideload} onClose={() => setSideload(false)} />
    </div>
  )
}
