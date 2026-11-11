import * as React from "react"
import * as ToggleGroup from "@animate-ui/react/primitives/radix-ui/toggle-group"

import { cn } from "@/lib/utils"

/* 分段切换:同一组里选一个(视图、触发方式、筛选)。Radix ToggleGroup 负责键盘方向键与无障碍。 */
export interface SegmentedOption<T extends string> { value: T; label: React.ReactNode; testid?: string; disabled?: boolean }

export function Segmented<T extends string>({ value, onChange, options, size = "sm", className, ariaLabel }: {
  value: T
  onChange: (v: T) => void
  options: readonly SegmentedOption<T>[]
  size?: "xs" | "sm"
  className?: string
  ariaLabel: string
}) {
  return (
    <ToggleGroup.Root type="single" value={value} aria-label={ariaLabel} onValueChange={(v) => { if (v) onChange(v as T) }}
      className={cn("inline-flex items-center gap-0.5 rounded-lg bg-hover p-0.5", className)}>
      {options.map((o) => (
        <ToggleGroup.Item key={o.value} value={o.value} disabled={o.disabled ?? false} data-testid={o.testid}
          className={cn("inline-flex items-center gap-1.5 whitespace-nowrap rounded-md font-medium text-fg-2 transition-[color,background-color,box-shadow] duration-fast ease-out hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 disabled:opacity-45 data-[state=on]:bg-elev data-[state=on]:text-fg data-[state=on]:shadow-soft",
            size === "xs" ? "h-6 px-2 text-[12px]" : "h-7 px-2.5 text-[12.5px]")}>
          {o.label}
        </ToggleGroup.Item>
      ))}
    </ToggleGroup.Root>
  )
}
