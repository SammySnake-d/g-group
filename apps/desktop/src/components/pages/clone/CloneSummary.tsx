import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/* 第三步「确认」的两栏:会带过去 / 不会带过去,每栏若干小节 */

export function Column({ title, icon, children, testid, muted }: { title: string; icon: ReactNode; children: ReactNode; testid: string; muted?: boolean }) {
  return (
    <section data-testid={testid} className={cn('min-w-0 rounded-xl border border-line px-3 py-3', muted ? 'bg-hover/40' : 'bg-bg')}>
      <h4 className="mb-2.5 flex items-center gap-1.5 text-[13px] font-medium">{icon}{title}</h4>
      <div className="space-y-3">{children}</div>
    </section>
  )
}

export function Sub({ title, lines }: { title: string; lines: string[] }) {
  return (
    <div className="min-w-0">
      <div className="text-[12px] font-medium tabular-nums text-fg-2">{title}</div>
      <ul className="mt-1 space-y-0.5">
        {lines.map((l, i) => <li key={i} className="line-clamp-2 text-[12.5px] leading-snug text-fg-3">· {l}</li>)}
      </ul>
    </div>
  )
}
