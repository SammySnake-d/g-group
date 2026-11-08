import * as React from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

/* 列表行(会话、联系人、文件):整行可点的按钮。基于 Button 原语拿到焦点环、禁用态和语义,
   去掉尺寸档(行里有头像和小图标,不能被 [&_svg]:size-* 统一改大小)和按下缩放(列表导航是高频操作,不加动效)。
   本地原语:leader 决定是否上提到 components/ui。 */
export const ListRow = React.forwardRef<HTMLButtonElement, React.ComponentPropsWithoutRef<typeof Button> & { selected?: boolean }>(
  ({ className, selected, ...props }, ref) => (
    <Button ref={ref} variant={null} size={null} shape={null} data-selected={selected ? '1' : undefined}
      className={cn('flex w-full items-center justify-start whitespace-normal text-left font-normal text-fg active:scale-100', selected ? 'bg-sel' : 'hover:bg-hover', className)} {...props} />
  ),
)
ListRow.displayName = 'ListRow'
