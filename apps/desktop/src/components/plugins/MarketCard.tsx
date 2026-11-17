/* 市场里的一张插件卡:图标 + 名字 + 发布者 → 一句话简介 → 类别、命令、能做的那一件事。整张卡点了进详情。 */
import type { PluginManifest } from '@g-group/ui-core'
import type { PluginState } from '@/data'
import { Chip } from '@/components/ui/chip'
import { surfaceVariants } from '@/components/ui/surface'
import { cn } from '@/lib/utils'
import { ActionButton } from './ActionButton'
import type { PluginFlow } from './flow'
import { CategoryTag, CommandTag, PluginIcon, Publisher } from './tags'

export function MarketCard({ m, s, upd, matched, flow, open }: { m: PluginManifest; s: PluginState | null; upd: boolean; matched: string[]; flow: PluginFlow; open: (id: string) => void }) {
  const cmds = m.contributes.commands
  return (
    <div role="button" tabIndex={0} data-testid={`plg-card-${m.id}`} data-phase={s?.phase ?? 'not_installed'} onClick={() => open(m.id)} onKeyDown={(e) => { if (e.key === 'Enter') open(m.id) }}
      className={cn(surfaceVariants({ elevation: 'flat', radius: 'xl', interactive: true }), 'group flex cursor-pointer flex-col p-4 outline-none transition-[border-color,box-shadow] duration-base ease-out hover:shadow-soft focus-visible:ring-2 focus-visible:ring-ring/60')}>
      <div className="flex items-start gap-3">
        <PluginIcon m={m} size={44} />
        <div className="min-w-0 flex-1 pt-0.5">
          <div className="flex min-w-0 items-center gap-1.5">
            <span data-testid="plg-card-name" className="truncate text-[15px] font-semibold tracking-[-0.01em]">{m.name}</span>
            {upd && <Chip data-testid={`plg-has-update-${m.id}`} tone="warm" size="xs">有更新</Chip>}
          </div>
          <Publisher name={m.publisher} className="mt-0.5 flex text-[12px] text-fg-3" />
        </div>
      </div>
      <p className="mt-2.5 line-clamp-2 min-h-[38px] text-pretty text-[13px] leading-[19px] text-fg-2">{m.summary}</p>
      <div className="mt-auto flex min-w-0 items-center gap-1.5 pt-3.5">
        <CategoryTag c={m.category} />
        {cmds.slice(0, 2).map((c) => <CommandTag key={c.name} hit={matched.includes('command')} className="min-w-0 truncate">/{c.name}</CommandTag>)}
        <span className="flex-1" />
        <ActionButton m={m} s={s} upd={upd} flow={flow} />
      </div>
    </div>
  )
}
