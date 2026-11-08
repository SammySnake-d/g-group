import { ChevronRight } from 'lucide-react'
import { gateCompute, resolveCompute, type ContactModels } from '@g-group/ui-core'
import { cn } from '@/lib/utils'
import { useApp } from '@/ctx'
import { Button } from '@/components/ui/button'
import { MODE_LABEL, type ModelSettings } from '@/modelConfig'
import { DEFAULTS } from './constants'

/** 各联系人现在用的模型:只读一览,点一行去它的工作台「设置」里改(模型只在两处配) */
export function ModelOverview({ contacts, s }: { contacts: ContactModels[]; s: ModelSettings }) {
  const { openWorkbench } = useApp()
  return (
    <div className="mx-3 mb-3" data-testid="model-overview">
      <div className="flex items-center px-1 pb-1.5 pt-2 text-[12px] font-medium text-fg-3"><span className="flex-1">{DEFAULTS.overview}</span></div>
      <div className="overflow-hidden rounded-xl bg-hover/60 [&>*+*]:border-t [&>*+*]:border-line">
        {contacts.map((c) => {
          const r = resolveCompute(c, s)
          const ok = gateCompute('launch', c, s).allowed
          return (
            <Button key={c.id} data-testid={`model-row-${c.id}`} variant="ghost" size="md" onClick={() => openWorkbench(c.id, 'settings')}
              className="h-auto w-full justify-start gap-3 rounded-none px-4 py-2 text-left font-normal text-fg active:scale-100">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 text-[13.5px] font-medium">
                  {!ok && <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-err" />}
                  <span className="truncate">{c.name}</span>
                </div>
                <div className="truncate font-mono text-[11.5px] text-fg-2">
                  <span data-testid={`model-row-talk-${c.id}`}>说话 {c.speakingModel}</span>
                  <span className="text-fg-3"> · </span>
                  <span data-testid={`model-row-compute-${c.id}`} className={cn(!ok && 'text-err')}>Compute {r.model.value} · {r.harness.value}</span>
                  <span className="font-sans text-fg-3">（{MODE_LABEL[c.computeModel.mode]}）</span>
                </div>
              </div>
              <ChevronRight aria-hidden className="text-fg-3" />
            </Button>
          )
        })}
      </div>
    </div>
  )
}
