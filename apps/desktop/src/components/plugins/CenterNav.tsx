/* 插件中心左边自己的一栏:发现 / 已安装 / 有更新 + 类别 + 从文件或地址安装。 */
import { FileUp } from 'lucide-react'
import { CATEGORY_LABEL, PLUGIN_CATEGORIES, type PluginCategory } from '@g-group/ui-core'
import { useApp } from '@/ctx'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { COPY, COPY_LIVE, TABS, type PluginTab } from './constants'

type Counts = { all: number; installed: number; updates: number; byCategory: Record<PluginCategory, number> }

const row = 'h-auto w-full justify-start gap-2.5 rounded-lg px-2.5 text-left font-normal active:scale-100'

export function CenterNav({ tab, inDetail, cat, counts, onTab, onCat, onSideload }: {
  tab: PluginTab; inDetail: boolean; cat: PluginCategory | 'all'; counts: Counts
  onTab: (t: PluginTab) => void; onCat: (c: PluginCategory | 'all') => void; onSideload: () => void
}) {
  const live = useApp((s) => s.backend.mode === 'connected')
  return (
    <aside className="flex w-[228px] shrink-0 flex-col border-r border-line bg-side px-3 pb-3 pt-4">
      <div className="px-2.5 pb-3">
        <div className="text-[16px] font-semibold tracking-[-0.01em]">{COPY.centerTitle}</div>
        <div className="mt-0.5 text-pretty text-[12px] leading-snug text-fg-3">{live ? COPY_LIVE.centerDesc : COPY.centerDesc}</div>
      </div>
      <div role="tablist" aria-label="插件" aria-orientation="vertical" className="space-y-0.5">
        {TABS.map(({ k, label, icon: I, badge }) => {
          const on = tab === k
          const n = counts[k === 'discover' ? 'all' : k]
          return (
            <Button key={k} data-testid={`plg-tab-${k}`} role="tab" aria-selected={on && !inDetail} variant="ghost" size={null} onClick={() => onTab(k)}
              className={cn(row, 'h-9 text-[13.5px]', on ? 'bg-sel font-medium text-fg hover:bg-sel' : 'text-fg-2')}>
              <I className="h-4 w-4" strokeWidth={on ? 2 : 1.75} /><span className="flex-1">{label}</span>
              {badge ? (n > 0 && <span className="grid h-[18px] min-w-[18px] place-items-center rounded-full bg-warm-dot px-1 text-[10.5px] font-semibold tabular-nums text-bg">{n}</span>)
                : <span className="text-[12px] tabular-nums text-fg-3">{n}</span>}
            </Button>
          )
        })}
      </div>
      <div className="mb-1 mt-5 px-2.5 text-[11.5px] font-medium text-fg-3">{COPY.categories}</div>
      <div className="scroll-thin min-h-0 space-y-0.5 overflow-y-auto">
        {(['all', ...PLUGIN_CATEGORIES] as const).map((c) => {
          const on = tab === 'discover' && cat === c
          return (
            <Button key={c} data-testid={`plg-cat-${c}`} aria-pressed={on} variant="ghost" size={null} onClick={() => onCat(c)}
              className={cn(row, 'h-8 text-[13px]', on && !inDetail ? 'bg-hover font-medium text-fg' : 'text-fg-2')}>
              <span className="flex-1 truncate">{c === 'all' ? COPY.allCategories : CATEGORY_LABEL[c]}</span>
              <span className="text-[12px] tabular-nums text-fg-3">{c === 'all' ? counts.all : counts.byCategory[c]}</span>
            </Button>
          )
        })}
      </div>
      <div className="flex-1" />
      <Button data-testid="plg-sideload-open" variant="outline" size={null} onClick={onSideload}
        className="mt-3 h-auto w-full justify-start gap-2 whitespace-normal rounded-xl border-dashed border-fg-3/40 bg-transparent px-2.5 py-2.5 text-left shadow-none hover:border-fg-3">
        <FileUp className="h-4 w-4 shrink-0 text-fg-2" />
        <span className="min-w-0"><span className="block text-[13px] font-medium">{COPY.sideloadTitle}</span><span className="block whitespace-nowrap text-[11px] font-normal text-fg-3">{COPY.sideloadHint}</span></span>
      </Button>
      <p data-testid="plg-mode-note" className="mt-2 px-1 text-pretty text-[11px] leading-snug text-fg-3">{live ? COPY_LIVE.liveNote : COPY.demoNote}</p>
    </aside>
  )
}
