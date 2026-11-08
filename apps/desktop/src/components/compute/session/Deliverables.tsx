import { FileDiff, FileText, Link2, Quote, type LucideIcon } from 'lucide-react'
import type { DeliverableEvent, FileChange } from '@g-group/ui-core'
import { COPY } from '../constants'
import { DiffStat } from '../parts'

/* 本轮交付(mirasim Sjt / Vdt)：细线隔开，小标签，下面一排文件卡——细边、极淡底、文件名 13px、大小 11px。
   再下面是改动文件清单（路径 + 增删行数）。演示阶段交付还打不开，卡片不做成可点的样子。 */

const ICON: Record<DeliverableEvent['type'], LucideIcon> = { file: FileText, diff: FileDiff, link: Link2, text: Quote }

export function Deliverables({ items, changes }: { items: DeliverableEvent[]; changes: FileChange[] }) {
  if (!items.length && !changes.length) return null
  return (
    <section className="space-y-3 border-t border-line pt-3" data-testid="session-deliverables">
      {items.length > 0 && (
        <div className="space-y-1.5">
          <h3 className="text-[11px] font-normal text-fg-3">{COPY.deliverables}</h3>
          <ul className="flex flex-wrap items-start gap-2">
            {items.map((d) => {
              const I = ICON[d.type]
              return (
                <li key={d.ref} className="flex min-w-0 max-w-[340px] items-center gap-2.5 rounded-md border border-line bg-hover/40 px-3 py-2" data-testid="deliverable">
                  <I aria-hidden className="size-4 shrink-0 text-fg-3" strokeWidth={1.75} />
                  <span className="min-w-0">
                    <span className="block truncate text-[13px] font-medium text-fg-2">{d.name}</span>
                    <span className="block truncate font-code text-[11px] text-fg-3">{d.size ? `${d.ref} · ${d.size}` : d.ref}</span>
                  </span>
                </li>
              )
            })}
          </ul>
        </div>
      )}
      {changes.length > 0 && (
        <div className="space-y-1">
          <h3 className="text-[11px] font-normal text-fg-3">{COPY.changes}<span className="ml-1.5 font-code tabular-nums">{changes.length}</span></h3>
          <ul className="space-y-0.5" data-testid="session-changes">
            {changes.map((c) => (
              <li key={c.path} className="flex min-w-0 items-baseline gap-2 font-code text-[11.5px]">
                <span className="min-w-0 truncate text-fg-2" title={c.path}>{c.path}</span>
                <DiffStat added={c.added} removed={c.removed} />
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}
