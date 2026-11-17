import * as ToggleGroup from '@animate-ui/react/primitives/radix-ui/toggle-group'
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/* 单选一组可视的选项(外观主题、头像形象、颜色):Animate UI 的 Radix ToggleGroup——
   方向键在组内移动、选中项 aria-checked;选中高亮的过渡由库做。和 Segmented 的区别:选项是自定义画面而不是文字。 */
export function ChoiceGroup({ value, onChange, label, children, className }: { value: string; onChange: (v: string) => void; label: string; children: ReactNode; className?: string }) {
  return (
    <ToggleGroup.Root type="single" value={value} aria-label={label} onValueChange={(v) => { if (v) onChange(v) }} className={className}>
      {children}
    </ToggleGroup.Root>
  )
}

export function Choice({ value, label, children, className }: { value: string; label: string; children: ReactNode; className?: string }) {
  return (
    <ToggleGroup.Item value={value} aria-label={label}
      className={cn('outline-none transition-[background-color,border-color,box-shadow,color] duration-fast ease-out focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-1 focus-visible:ring-offset-elev', className)}>
      {children}
    </ToggleGroup.Item>
  )
}
