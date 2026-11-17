/* 发现:搜名称 / 简介 / 命令,按类别筛,排序;卡片网格。 */
import { Search, X } from 'lucide-react'
import { CATEGORY_DESC, CATEGORY_LABEL, marketList, type MarketSort, type PluginCategory } from '@g-group/ui-core'
import type { PluginState } from '@/data'
import { useApp } from '@/ctx'
import { Button } from '@/components/ui/button'
import { SelectMenu } from '@/components/ui/field'
import { IconButton } from '@/components/ui/icon-button'
import { COPY, COPY_LIVE, SORT_OPTIONS } from './constants'
import type { PluginFlow } from './flow'
import { EmptyBox, PageHead } from './layout'
import { MarketCard } from './MarketCard'

export function Discover({ text, setText, cat, sort, setSort, flow, open, onSideload }: {
  text: string; setText: (v: string) => void; cat: PluginCategory | 'all'; sort: MarketSort; setSort: (s: MarketSort) => void; flow: PluginFlow; open: (id: string) => void; onSideload: () => void
}) {
  const { plugins, pluginCatalog } = useApp()
  /* 连着后端:插件市场目录按用户决定暂不接(plugins.marketplace),这里只列得出已装的;把这句写在页上 */
  const live = useApp((s) => s.backend.mode === 'connected')
  const items = marketList(pluginCatalog, plugins, { text, category: cat, filter: 'all', sort })
  return (
    <div className="mx-auto max-w-[1120px] px-8 pb-14 pt-7" data-testid="plg-discover">
      <PageHead title={cat === 'all' ? COPY.discoverTitle : CATEGORY_LABEL[cat]} desc={cat === 'all' ? COPY.discoverDesc : CATEGORY_DESC[cat]}>
        <label className="flex h-10 w-[380px] max-w-full items-center gap-2 rounded-xl border border-line bg-bg pl-3 pr-1.5 text-fg-3 transition-[border-color,box-shadow] duration-fast ease-out focus-within:border-fg-3 focus-within:ring-2 focus-within:ring-ring/25">
          <Search className="h-4 w-4 shrink-0" />
          <input data-testid="plg-search" value={text} onChange={(e) => setText(e.target.value)} placeholder={COPY.searchPlaceholder} aria-label="搜索插件"
            className="min-w-0 flex-1 bg-transparent text-[13.5px] text-fg outline-none placeholder:text-fg-3" />
          {text && <IconButton label="清空搜索" tooltip={false} size="icon-xs" icon={<X />} onClick={() => setText('')} />}
        </label>
        <SelectMenu testid="plg-sort" label="排序" value={sort} onChange={setSort} options={SORT_OPTIONS} size="lg" align="end" className="w-[136px] rounded-xl text-[13px] text-fg-2" />
      </PageHead>
      {live && <p data-testid="plg-market-off" role="note" className="mt-4 rounded-xl bg-hover px-3.5 py-2.5 text-[12.5px] leading-relaxed text-fg-2">{COPY_LIVE.marketOff}</p>}
      {items.length === 0 ? (
        <EmptyBox testid="plg-empty" className="mt-10">
          <div className="text-[14px] font-medium text-fg">{text ? `没找到和「${text}」有关的插件` : '这一类还没有插件'}</div>
          <div className="mt-1.5">换个说法搜搜看，或者 <Button variant="link" size={null} className="text-[13px]" onClick={onSideload}>{COPY.sideloadTitle}</Button></div>
        </EmptyBox>
      ) : (
        <div data-testid="plg-grid" className="mt-6 grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-3.5">
          {items.map((it) => <MarketCard key={it.manifest.id} m={it.manifest} s={it.install as PluginState | null} upd={it.hasUpdate} matched={it.matched} flow={flow} open={open} />)}
        </div>
      )}
    </div>
  )
}
