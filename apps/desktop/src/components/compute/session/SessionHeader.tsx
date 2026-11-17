import { Fragment } from 'react'
import { ArrowLeft, ChevronRight, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Chip } from '@/components/ui/chip'
import { IconButton } from '@/components/ui/icon-button'
import { COPY } from '../constants'
import { StatusChip, type ComputeState } from '../StatusChip'

/* 顶栏照 mirasim 会话窗口：返回 + 类型标签 + 标题（一行，省略号）+ 右侧状态与关闭；第二行是来源面包屑，末项加粗。
   类型标签写 harness 名(Claude Code / Codex)，它就是用户说的「具体的 harness」。 */

export interface Crumb { label: string; onClick?: () => void }

export function SessionHeader({ harness, title, state, crumbs, onBack, onClose }: { harness: string; title: string; state: ComputeState; crumbs: Crumb[]; onBack?: () => void; onClose?: () => void }) {
  return (
    <header className="shrink-0 border-b border-line px-3 pb-2 pt-2.5" data-testid="session-header">
      <div className="flex min-w-0 items-center gap-2">
        {onBack && <IconButton label={COPY.back} icon={<ArrowLeft />} size="icon-sm" onClick={onBack} data-testid="session-back" />}
        <Chip tone="neutral" size="sm" className="bg-sel text-fg" data-testid="session-harness">{harness}</Chip>
        <h2 className="min-w-0 flex-1 truncate text-[15px] font-semibold tracking-[-0.01em]" title={title} data-testid="session-title">{title}</h2>
        <StatusChip state={state} testId="session-status" />
        {onClose && <IconButton label={COPY.close} icon={<X />} size="icon-sm" onClick={onClose} data-testid="session-close" />}
      </div>
      <nav aria-label={COPY.source} className={onBack ? 'pl-9' : undefined}>
        <ol className="mt-1 flex min-w-0 items-center gap-0.5 text-[12px] text-fg-3" data-testid="session-crumbs">
          {crumbs.map((c, i) => {
            const last = i === crumbs.length - 1
            return (
              <Fragment key={`${i}-${c.label}`}>
                {i > 0 && <ChevronRight aria-hidden className="size-3 shrink-0 text-fg-3/70" />}
                <li className={last ? 'min-w-0 truncate font-medium text-fg-2' : 'min-w-0 shrink truncate'} aria-current={last ? 'page' : undefined}>
                  {c.onClick && !last ? (
                    <Button variant="ghost" size="xs" onClick={c.onClick} className="h-6 max-w-full px-1 text-[12px] font-normal text-fg-3 active:scale-100">
                      <span className="truncate">{c.label}</span>
                    </Button>
                  ) : (
                    <span className="px-1">{c.label}</span>
                  )}
                </li>
              </Fragment>
            )
          })}
        </ol>
      </nav>
    </header>
  )
}
