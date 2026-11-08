import { cn } from '@/lib/utils'
import { useApp } from '@/ctx'
import { Chip } from '@/components/ui/chip'
import { ListGroup } from '@/components/ui/list-row'
import { Hint, PageScroll } from './kit/parts'
import { PLAYBOOK_KINDS, PLAYBOOK_SCOPE } from './constants'

/* ---------- US14 群协作手册:按分工 / 交接 / 纠正落点 / 可信度分组,每条写明来源与适用范围 ---------- */
export function PlaybookPage({ id: _id }: { id: string }) {
  const { playbook } = useApp()
  return (
    <PageScroll className="px-1">
      <Hint className="mx-4 mb-3">大家在这个群里磨出来的配合方式。每条都写明来自哪句话。助手定期复盘提修改，你同意后才生效。</Hint>
      {PLAYBOOK_KINDS.map((k) => {
        const list = playbook.filter((p) => p.kind === k)
        if (!list.length) return null
        return (
          <ListGroup key={k} title={k}>
            {list.map((p) => (
              <div key={p.id} className="px-4 py-2.5">
                <div className="text-[13.5px] leading-relaxed">{p.text}</div>
                <div className="mt-1 flex min-w-0 items-center gap-2 text-[11.5px] text-fg-3">
                  <Chip size="xs" tone={p.scope === 'project' ? 'warm' : 'neutral'} className={cn(p.scope !== 'project' && 'bg-elev')}>{PLAYBOOK_SCOPE[p.scope]}</Chip>
                  <span className="min-w-0 truncate">来自 {p.src}</span>
                </div>
              </div>
            ))}
          </ListGroup>
        )
      })}
    </PageScroll>
  )
}
