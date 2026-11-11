import * as TabsPrimitive from '@animate-ui/react/primitives/radix-ui/tabs'
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/* 下划线页签(工作台、联系人分栏、对话细节、Compute 视图共用):Animate UI 的 Radix Tabs——
   role=tab / aria-selected、←→ 方向键与 Home/End 来自 Radix;选中下划线的滑动、页面切换的淡入淡出和高度过渡
   都由库按它的 token 做(用户 #976:动效数值交给库)。我们只给静态样式:下划线画在 ::after 上,
   库会把选中项的样式复制到一条滑动指示条上。
   本地原语;若别的模块也要用,由 leader 决定是否上提到 components/ui/tabs.tsx。 */

export type TabItem<T extends string> = { value: T; label: ReactNode; testid?: string }

export function Tabs<T extends string>({ value, onValueChange, children, className }: { value: T; onValueChange: (v: T) => void; children: ReactNode; className?: string }) {
  return (
    <TabsPrimitive.Root value={value} onValueChange={(v) => onValueChange(v as T)} className={className}>
      {children}
    </TabsPrimitive.Root>
  )
}

const sizes = {
  sm: 'h-8 px-2.5 text-[12.5px]',
  md: 'h-9 px-3 text-[13.5px]',
} as const

export function TabList<T extends string>({ items, label, size = 'md', className }: { items: readonly TabItem<T>[]; label: string; size?: keyof typeof sizes; className?: string }) {
  return (
    <TabsPrimitive.List aria-label={label} className={cn('no-scrollbar relative -mb-px flex gap-0.5 overflow-x-auto', className)}>
      {items.map((t) => (
        <TabsPrimitive.Trigger
          key={t.value}
          value={t.value}
          data-testid={t.testid}
          className={cn(
            'relative shrink-0 whitespace-nowrap rounded-t-md text-fg-2 tabular-nums outline-none hover:text-fg',
            'focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/60',
            'after:pointer-events-none after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full after:bg-transparent',
            'data-[state=active]:font-semibold data-[state=active]:text-fg data-[state=active]:after:bg-fg',
            sizes[size],
          )}
        >
          {t.label}
        </TabsPrimitive.Trigger>
      ))}
    </TabsPrimitive.List>
  )
}

/** 页签内容:只渲染当前页;切换时库负责旧页淡出、新页淡入和高度过渡。focus 环交给里面的控件 */
export function TabPanel({ value, children, className }: { value: string; children: ReactNode; className?: string }) {
  return (
    <TabsPrimitive.Content value={value} tabIndex={-1} className={cn('outline-none', className)}>
      {children}
    </TabsPrimitive.Content>
  )
}
