import { useState } from 'react'
import { Check, ChevronRight, Terminal, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { Compute } from '@/data'
import { ListItem } from '@/components/ui/list-row'
import { Spinner } from '@/components/ui/spinner'
import { Collapse } from './Collapse'

/* 检查:每一项一行,点开看命令、输出和测试写在哪。通过 = 绿对勾,没过 = 红叉,在查 = 绿色转圈 + 文字 */
export function ChecksView({ c }: { c: Compute }) {
  const [open, setOpen] = useState<number | null>(null)
  return (
    <ul className="space-y-0.5" data-testid="checks">
      {c.checks.map((k, i) => (
        <li key={i} className={cn('rounded-lg transition-colors duration-fast ease-out', open === i && 'bg-hover/50')}>
          <ListItem
            aria-expanded={open === i}
            onClick={() => setOpen(open === i ? null : i)}
            className="gap-2.5 rounded-lg px-2 py-2 hover:bg-hover/60"
            media={<span className="grid h-4 w-4 shrink-0 place-items-center">{k.ok === true ? <Check aria-label="通过" className="h-4 w-4 text-ok" strokeWidth={2.5} /> : k.ok === false ? <X aria-label="没通过" className="h-4 w-4 text-err" /> : <Spinner size="xs" />}</span>}
            title={<span className={cn('font-normal', k.ok === null && 'text-fg-2')}>{k.text}</span>}
            trailing={<>
              {k.ok === null && <span className="shrink-0 text-[12px] text-fg-3">正在检查</span>}
              <ChevronRight className={cn('h-3.5 w-3.5 shrink-0 text-fg-3 transition-transform duration-fast ease-out', open === i && 'rotate-90')} />
            </>}
          />
          <Collapse open={open === i}>
            <div className="space-y-1.5 px-2 pb-2.5 pl-9 text-[12.5px]">
              {k.cmd && <div className="flex min-w-0 items-center gap-2"><Terminal className="h-3.5 w-3.5 shrink-0 text-fg-3" /><code className="min-w-0 truncate font-mono text-fg-2">{k.cmd}</code></div>}
              {k.out ? <pre className="scroll-thin max-h-56 overflow-auto whitespace-pre-wrap rounded-md bg-bg px-3 py-2 font-mono text-[12px] text-fg-2">{k.out}</pre> : <div className="text-fg-3">还没有输出</div>}
              {k.file && <div className="min-w-0 truncate text-fg-3">测试写在 <span className="font-mono">{k.file}</span></div>}
            </div>
          </Collapse>
        </li>
      ))}
    </ul>
  )
}
