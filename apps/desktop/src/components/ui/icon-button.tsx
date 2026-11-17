import * as React from "react"
import { type VariantProps } from "class-variance-authority"

import { Button, type buttonVariants } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

/* 只有图标的按钮:必须给 label(无障碍名 + 悬停提示,Vercel「Icon-only buttons are named」)。
   active = 当前所在/已打开,用选中底色而不是改图标颜色。 */
export interface IconButtonProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  label: string
  icon: React.ReactNode
  size?: "icon-xs" | "icon-sm" | "icon" | "icon-lg"
  variant?: VariantProps<typeof buttonVariants>["variant"]
  active?: boolean
  tooltip?: boolean
  side?: "top" | "right" | "bottom" | "left"
  /** 角标(未读数等) */
  badge?: React.ReactNode
}

export const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(
  ({ label, icon, size = "icon", variant = "ghost", active, tooltip = true, side = "bottom", badge, className, ...props }, ref) => {
    const btn = (
      <Button ref={ref} aria-label={label} aria-pressed={active ?? undefined} data-active={active ? "1" : undefined} variant={variant} size={size}
        className={cn("relative", active && "bg-sel text-fg hover:bg-sel", className)} {...props}>
        {icon}
        {badge}
      </Button>
    )
    if (!tooltip) return btn
    return (
      <Tooltip>
        <TooltipTrigger asChild>{btn}</TooltipTrigger>
        <TooltipContent side={side}>{label}</TooltipContent>
      </Tooltip>
    )
  }
)
IconButton.displayName = "IconButton"
