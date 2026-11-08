import { Fragment } from 'react'
import { ArrowRight } from 'lucide-react'
import type { Resolved } from '@g-group/ui-core'
import { cn } from '@/lib/utils'
import { hopParts } from '@/modelConfig'

/** 一条继承链:每一跳「来自哪里」,最后一跳的取值就是生效值(描边突出) */
export function Chain({ r, testid }: { r: Resolved; testid: string }) {
  return (
    <span data-testid={testid} className="flex min-w-0 flex-wrap items-center gap-x-1 gap-y-0.5">
      {r.chain.map((h, i) => {
        const { where, value } = hopParts(h)
        const last = i === r.chain.length - 1
        return (
          <Fragment key={i}>
            {i > 0 && <ArrowRight aria-hidden className="h-3 w-3 shrink-0 text-fg-3" />}
            <span className="text-fg-2">{where}</span>
            {value !== undefined && <code className={cn('rounded-md px-1.5 py-px font-mono text-[11.5px]', last ? 'bg-bg font-medium text-fg ring-1 ring-line' : 'text-fg-2')}>{value}</code>}
          </Fragment>
        )
      })}
    </span>
  )
}
