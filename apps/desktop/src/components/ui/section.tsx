import * as React from "react"

import { cn } from "@/lib/utils"

/* 区块标题:标题 + 计数 + 右侧操作。标题自己承担层级,不加眉题小字(impeccable craft floor)。 */
export function SectionHeader({ title, count, action, className, id }: { title: React.ReactNode; count?: React.ReactNode; action?: React.ReactNode; className?: string; id?: string }) {
  return (
    <div className={cn("flex min-h-8 items-center gap-2", className)}>
      <h3 id={id} className="min-w-0 flex-1 truncate text-[13px] font-semibold tracking-[-0.005em] text-fg">
        {title}
        {count !== undefined && <span className="ml-1.5 font-normal tabular-nums text-fg-3">{count}</span>}
      </h3>
      {action}
    </div>
  )
}

/* 空状态:说清这里会出现什么、下一步做什么(Vercel「No dead ends」)。 */
export function EmptyState({ icon, title, hint, action, className }: { icon?: React.ReactNode; title: React.ReactNode; hint?: React.ReactNode; action?: React.ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-col items-center gap-2 px-6 py-10 text-center", className)}>
      {icon && <div className="grid h-10 w-10 place-items-center rounded-xl bg-hover text-fg-3 [&_svg]:size-5">{icon}</div>}
      <div className="text-[13.5px] font-medium text-fg">{title}</div>
      {hint && <p className="max-w-[36ch] text-[12.5px] leading-relaxed text-fg-2">{hint}</p>}
      {action}
    </div>
  )
}
