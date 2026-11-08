import * as React from "react"
import { ChevronRight } from "lucide-react"

import { cn } from "@/lib/utils"

/* 列表原语(设置页、资料页、浮层页):
   - ListGroup:一组行,上面一行小标题,组内用 1px 细线分隔(iOS 设置式,标题自己承担层级,不加眉题)
   - ListRow:「标签 - 值 - 箭头」一行;能点就是 button(自带 focus 环、按下底色),不能点就是 div
   - ListItem:带头像/图标的可点条目(选会话、搜索结果、文件),标题省略、副标题一行或两行
   命中区 ≥ 44px(行)/ 40px(条目);值用 tabular-nums,长文本省略且容器 min-w-0(Vercel)。 */

const pressable =
  "transition-[background-color,color] duration-fast ease-out hover:bg-hover active:bg-sel focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/60 disabled:pointer-events-none disabled:opacity-45"

export function ListGroup({ title, action, children, className, testid }: {
  title?: React.ReactNode
  /** 小标题右侧的操作(「全部」「编辑」) */
  action?: React.ReactNode
  children: React.ReactNode
  className?: string
  testid?: string
}) {
  return (
    <section data-testid={testid} className={cn("mx-3 mb-3", className)}>
      {title && (
        <div className="flex min-h-7 items-center gap-2 px-1 pb-1 pt-2">
          <h4 className="min-w-0 flex-1 truncate text-[12px] font-medium text-fg-3">{title}</h4>
          {action}
        </div>
      )}
      <div className="overflow-hidden rounded-xl bg-hover/60 [&>*+*]:border-t [&>*+*]:border-line">{children}</div>
    </section>
  )
}

export interface ListRowProps {
  label: React.ReactNode
  value?: React.ReactNode
  /** 有 onClick 时整行是按钮,右侧带箭头 */
  onClick?: () => void
  /** 行尾的控件(开关、图标);和 onClick 二选一 */
  children?: React.ReactNode
  testid?: string
  tone?: "default" | "danger"
  /** 只要箭头不要值时也可以关掉箭头 */
  chevron?: boolean
  className?: string
}

export const ListRow = React.forwardRef<HTMLElement, ListRowProps>(({ label, value, onClick, children, testid, tone = "default", chevron = true, className }, ref) => {
  const body = (
    <>
      <span className={cn("min-w-0 flex-1 truncate", tone === "danger" && "text-err")}>{label}</span>
      {value !== undefined && value !== null && value !== false && <span className="min-w-0 max-w-[60%] shrink truncate text-right tabular-nums text-fg-2">{value}</span>}
      {children}
      {onClick && chevron && <ChevronRight aria-hidden className="h-4 w-4 shrink-0 text-fg-3" />}
    </>
  )
  const cls = cn("flex min-h-11 w-full items-center gap-3 px-4 text-left text-[14px]", className)
  if (onClick)
    return (
      <button ref={ref as React.Ref<HTMLButtonElement>} type="button" data-testid={testid} onClick={onClick} className={cn(cls, pressable)}>
        {body}
      </button>
    )
  return (
    <div ref={ref as React.Ref<HTMLDivElement>} data-testid={testid} className={cls}>
      {body}
    </div>
  )
})
ListRow.displayName = "ListRow"

export interface ListItemProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "title"> {
  media?: React.ReactNode
  title: React.ReactNode
  subtitle?: React.ReactNode
  /** 副标题最多两行(搜索结果、消息摘录);默认一行省略 */
  clamp?: 1 | 2
  /** 行尾:箭头、时间、操作提示 */
  trailing?: React.ReactNode
  selected?: boolean
  /** 把副标题放在标题上面(搜索结果:先「谁 · #序号」再原文) */
  subtitleFirst?: boolean
}

export const ListItem = React.forwardRef<HTMLButtonElement, ListItemProps>(({ media, title, subtitle, clamp = 1, trailing, selected, subtitleFirst, className, type, ...props }, ref) => {
  const sub = subtitle !== undefined && subtitle !== null && (
    <div className={cn("text-[12px] text-fg-2", clamp === 2 ? "line-clamp-2" : "truncate")}>{subtitle}</div>
  )
  return (
    <button ref={ref} type={type ?? "button"} aria-current={selected || undefined} className={cn("flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left", pressable, selected && "bg-sel hover:bg-sel", className)} {...props}>
      {media}
      <div className="min-w-0 flex-1">
        {subtitleFirst && sub}
        <div className={cn("text-[14px]", subtitleFirst ? "line-clamp-2 text-[13.5px]" : "truncate font-medium")}>{title}</div>
        {!subtitleFirst && sub}
      </div>
      {trailing}
    </button>
  )
})
ListItem.displayName = "ListItem"
