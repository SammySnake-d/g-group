import * as React from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

/* 列表行(会话、联系人、文件):整行可点的按钮。基于 Button 原语拿到焦点环、禁用态和语义,
   去掉尺寸档(行里有头像和小图标,不能被 [&_svg]:size-* 统一改大小)和按下缩放(列表导航是高频操作,不加动效)。
   本地原语:leader 决定是否上提到 components/ui。 */
export const ListRow = React.forwardRef<HTMLButtonElement, React.ComponentPropsWithoutRef<typeof Button> & { selected?: boolean }>(
  ({ className, selected, ...props }, ref) => (
    <Button ref={ref} variant={null} size={null} shape={null} data-row="" data-selected={selected ? '1' : undefined}
      className={cn('flex w-full items-center justify-start whitespace-normal text-left font-normal text-fg active:scale-100', selected ? 'bg-sel' : 'hover:bg-hover', className)} {...props} />
  ),
)
ListRow.displayName = 'ListRow'

/** 列表里按 ↑/↓ 在行之间移动焦点(共同规则追加 2 第 5 条:方向键在组内移动)。挂在列表容器的 onKeyDown 上 */
export function moveRowFocus(e: React.KeyboardEvent<HTMLElement>) {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
  const rows = [...e.currentTarget.querySelectorAll<HTMLElement>('[data-row]:not(:disabled)')]
  const i = rows.indexOf(document.activeElement as HTMLElement)
  if (i < 0) return
  e.preventDefault()
  rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))]?.focus()
}
