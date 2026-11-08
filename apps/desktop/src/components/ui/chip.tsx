import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

/* 标签原语:状态、来源、类别、计数。颜色不单独表达含义,永远带文字(Vercel「Redundant status cues」)。 */
const chipVariants = cva("inline-flex max-w-full shrink-0 items-center gap-1 whitespace-nowrap font-medium leading-none tabular-nums [&_svg]:size-3 [&_svg]:shrink-0", {
  variants: {
    tone: {
      neutral: "",
      brand: "",
      warm: "",
      run: "",
      err: "",
      ok: "",
      link: "",
    },
    variant: {
      soft: "",
      outline: "border",
      dashed: "border border-dashed",
    },
    size: {
      xs: "h-[18px] rounded-md px-1.5 text-[10.5px]",
      sm: "h-5 rounded-md px-1.5 text-[11.5px]",
      md: "h-6 rounded-full px-2.5 text-[12px]",
    },
  },
  compoundVariants: [
    { tone: "neutral", variant: "soft", className: "bg-hover text-fg-2" },
    { tone: "brand", variant: "soft", className: "bg-brand-soft text-brand" },
    { tone: "warm", variant: "soft", className: "bg-warm-soft text-warm" },
    { tone: "run", variant: "soft", className: "bg-run-soft text-run" },
    { tone: "err", variant: "soft", className: "bg-err-soft text-err" },
    { tone: "ok", variant: "soft", className: "bg-run-soft text-ok" },
    { tone: "link", variant: "soft", className: "bg-me/10 text-me" },
    { tone: "neutral", variant: ["outline", "dashed"], className: "border-line text-fg-2" },
    { tone: "brand", variant: ["outline", "dashed"], className: "border-brand/40 text-brand" },
    { tone: "warm", variant: ["outline", "dashed"], className: "border-warm/40 text-warm" },
    { tone: "run", variant: ["outline", "dashed"], className: "border-run/40 text-run" },
    { tone: "err", variant: ["outline", "dashed"], className: "border-err/40 text-err" },
    { tone: "ok", variant: ["outline", "dashed"], className: "border-ok/40 text-ok" },
    { tone: "link", variant: ["outline", "dashed"], className: "border-me/40 text-me" },
  ],
  defaultVariants: { tone: "neutral", variant: "soft", size: "sm" },
})

export interface ChipProps extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof chipVariants> {}

export const Chip = React.forwardRef<HTMLSpanElement, ChipProps>(({ className, tone, variant, size, ...props }, ref) => (
  <span ref={ref} className={cn(chipVariants({ tone, variant, size }), className)} {...props} />
))
Chip.displayName = "Chip"
export { chipVariants }
