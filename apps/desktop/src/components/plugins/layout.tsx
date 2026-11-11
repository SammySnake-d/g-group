/* 插件中心右侧各页共用的版式:页头、空状态、详情页的分节和侧栏卡。 */
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

export function PageHead({ title, desc, children }: { title: string; desc: string; children?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
      <div className="min-w-0 flex-1">
        <h1 className="text-balance text-[22px] font-semibold tracking-[-0.02em]">{title}</h1>
        <p className="mt-1 max-w-[62ch] text-pretty text-[13px] leading-relaxed text-fg-2">{desc}</p>
      </div>
      {children}
    </div>
  )
}

/** 列表空了:说清这里会出现什么、下一步做什么 */
export function EmptyBox({ children, testid, className }: { children: ReactNode; testid?: string; className?: string }) {
  return <div data-testid={testid} className={cn('mt-8 rounded-2xl border border-dashed border-line px-6 py-12 text-center text-[13px] text-fg-2', className)}>{children}</div>
}

/** 详情页的一节:h2 标题 + 旁注 */
export function DetailSection({ title, sub, children, testid }: { title: string; sub?: string; children: ReactNode; testid?: string }) {
  return (
    <section data-testid={testid}>
      <div className="flex min-w-0 items-baseline gap-2"><h2 className="shrink-0 text-[15px] font-semibold tracking-[-0.01em]">{title}</h2>{sub && <span className="truncate text-[12px] text-fg-3">{sub}</span>}</div>
      <div className="mt-2.5">{children}</div>
    </section>
  )
}

/** 详情页右栏的一张卡 */
export function SideCard({ title, children, testid }: { title: string; children: ReactNode; testid?: string }) {
  return (
    <div data-testid={testid} className="rounded-2xl border border-line bg-elev p-4">
      <div className="mb-2.5 text-[13px] font-semibold">{title}</div>
      {children}
    </div>
  )
}
