import { Search, X } from 'lucide-react'
import { BUCKET_TILES, type BoardCounts, type BoardFilter, type BoardGroupBy, type BoardRange } from '@g-group/ui-core'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/icon-button'
import { Segmented } from '@/components/ui/segmented'
import { GROUP_LABEL, RANGE_LABEL, SEARCH_PLACEHOLDER, STATS, SUBTITLE, TILE_LABEL, TITLE } from './copy'

/*
  看板头部(mirasim ej / tj / Mo / va):标题下划线、状态块(点一下筛选,再点取消;失败 / 已停止为 0 时不显示;mirasim 是一排 aria-pressed 按钮,每块都有底色,不用会把未选底色抹掉的 ToggleGroup 高亮)、右侧汇总(总轮数、子任务在跑)、
  分组 / 时间分段、搜索。没有花费 / 额度(#877)。右上角的 × 由遮罩外壳给(App.tsx 的 pano-close),标题行给它留出位置。
*/

const groupOptions = (Object.keys(GROUP_LABEL) as BoardGroupBy[]).map((v) => ({ value: v, label: GROUP_LABEL[v], testid: `pano-group-${v}` }))
const rangeOptions = (Object.keys(RANGE_LABEL) as BoardRange[]).map((v) => ({ value: v, label: RANGE_LABEL[v], testid: `pano-range-${v}` }))

/** 状态块组内用左右方向键移动焦点(Tab 进出整组仍逐个可达) */
function arrowKeys(e: React.KeyboardEvent<HTMLElement>) {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
  const items = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('button')]
  const i = items.indexOf(document.activeElement as HTMLButtonElement)
  if (i < 0) return
  e.preventDefault()
  items[(i + (e.key === 'ArrowRight' ? 1 : items.length - 1)) % items.length]?.focus()
}

export function BoardHead({ filter, counts, set }: { filter: BoardFilter; counts: BoardCounts; set: (p: Partial<BoardFilter>) => void }) {
  const tiles = BUCKET_TILES.filter((b) => !((b === 'failed' || b === 'stopped') && counts[b] === 0 && filter.bucket !== b))
  return (
    <header className="bd-head">
      <div className="bd-title-row">
        <h2 className="bd-lens-tab">{TITLE}</h2>
        <span className="bd-sub">{SUBTITLE}</span>
      </div>
      <div className="bd-figures">
        <span className="bd-tiles" role="group" aria-label="按状态筛选" onKeyDown={arrowKeys}>
          {tiles.map((b) => (
            <Button key={b} variant={null} size={null} shape={null} className="bd-tile" data-group={b === 'all' ? undefined : b} data-testid={`pano-kpi-${b}`}
              aria-pressed={filter.bucket === b} onClick={() => set({ bucket: filter.bucket === b ? 'all' : b })}>
              <span className="bd-tile-num">{counts[b]}</span>
              <span className="bd-tile-label">{b !== 'all' && <span className="bd-dot" data-group={b} aria-hidden />}{TILE_LABEL[b]}</span>
            </Button>
          ))}
        </span>
        <span className="bd-stats">
          <span className="bd-stat"><span className="bd-tile-num" data-testid="pano-turns">{counts.turns}</span><span className="bd-tile-label">{STATS.turns}</span></span>
          <span className="bd-stat"><span className="bd-tile-num">{counts.subsRunning}</span><span className="bd-tile-label">{STATS.subsRunning}</span></span>
        </span>
      </div>
      <div className="bd-filters">
        <Segmented size="xs" ariaLabel="分组" value={filter.groupBy} onChange={(v) => set({ groupBy: v })} options={groupOptions} />
        <Segmented size="xs" ariaLabel="时间范围" value={filter.range} onChange={(v) => set({ range: v })} options={rangeOptions} />
        <label className="bd-search">
          <Search aria-hidden />
          <input data-testid="pano-search" value={filter.query} placeholder={SEARCH_PLACEHOLDER} aria-label={SEARCH_PLACEHOLDER}
            onChange={(e) => set({ query: e.target.value })}
            // 搜索框里 Esc 先清搜索,不关看板(遮罩的 Esc 监听挂在 window 上,这里拦住冒泡)
            onKeyDown={(e) => { if (e.key === 'Escape' && filter.query) { e.stopPropagation(); set({ query: '' }) } }} />
          {filter.query && <IconButton label="清空搜索" size="icon-xs" tooltip={false} icon={<X />} onClick={() => set({ query: '' })} />}
        </label>
      </div>
    </header>
  )
}
