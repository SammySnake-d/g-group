import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

/* 进行中:细环转圈。转速用 Tailwind 自带的 animate-spin(不自己定数值,用户 #976);
   prefers-reduced-motion 时不转,只剩一个半圈的静态环,仍然看得出「在做」。
   默认是装饰(aria-hidden),旁边已有文字说明;单独出现时给 label,读屏读得到。 */
const spinnerVariants = cva("inline-block shrink-0 rounded-full border-2 border-current border-r-transparent motion-safe:animate-spin", {
  variants: {
    size: { xs: "h-3 w-3 border-[1.5px]", sm: "h-3.5 w-3.5", md: "h-4 w-4", lg: "h-5 w-5" },
    tone: { run: "text-run", muted: "text-fg-3", current: "" },
  },
  defaultVariants: { size: "sm", tone: "run" },
})

export interface SpinnerProps extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof spinnerVariants> {
  /** 给了就作为状态播报(role=status),不给就是装饰 */
  label?: string
}

export const Spinner = React.forwardRef<HTMLSpanElement, SpinnerProps>(({ size, tone, label, className, ...props }, ref) => (
  <span
    ref={ref}
    role={label ? "status" : undefined}
    aria-label={label}
    aria-hidden={label ? undefined : true}
    className={cn(spinnerVariants({ size, tone }), className)}
    {...props}
  />
))
Spinner.displayName = "Spinner"
export { spinnerVariants }
