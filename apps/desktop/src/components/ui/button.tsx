import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

/* 按钮原语(g-group「纸·墨·柿」):
   primary 墨色主操作;brand 柿红,一屏最多一个(市场安装、首要转化);secondary 纸面;outline 细边;ghost 无底;danger 删除类。
   按下 scale(.97) 给回馈(Emil);只过渡颜色、阴影和 transform,不用 transition-all(Vercel)。 */
const buttonVariants = cva(
  "inline-flex shrink-0 select-none items-center justify-center gap-1.5 whitespace-nowrap font-medium transition-[color,background-color,border-color,box-shadow,transform] duration-fast ease-out active:scale-[.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-1 focus-visible:ring-offset-bg disabled:pointer-events-none disabled:opacity-45 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        primary: "bg-btn text-btn-fg shadow-soft hover:bg-btn/90",
        brand: "bg-brand text-brand-fg shadow-soft hover:bg-brand/90",
        secondary: "bg-hover text-fg hover:bg-sel",
        outline: "border border-line bg-elev text-fg shadow-soft hover:border-fg-3/50 hover:bg-hover",
        ghost: "text-fg-2 hover:bg-hover hover:text-fg",
        danger: "text-err hover:bg-err-soft",
        "danger-solid": "bg-err text-white shadow-soft hover:bg-err/90",
        link: "h-auto px-0 text-me underline-offset-4 hover:underline active:scale-100",
        /** 浮在内容上的小控件(回到最新、有人 @ 你) */
        floating: "border border-line bg-elev text-fg shadow-elev hover:bg-hover",
      },
      size: {
        xs: "h-7 px-2.5 text-[12.5px] [&_svg]:size-3.5",
        sm: "h-8 px-3 text-[13px] [&_svg]:size-4",
        md: "h-9 px-4 text-[13.5px] [&_svg]:size-4",
        "icon-xs": "h-6 w-6 [&_svg]:size-3.5",
        "icon-sm": "h-7 w-7 [&_svg]:size-4",
        icon: "h-8 w-8 [&_svg]:size-[18px]",
        "icon-lg": "h-10 w-10 [&_svg]:size-5",
      },
      shape: {
        rounded: "rounded-lg",
        pill: "rounded-full",
      },
    },
    compoundVariants: [{ size: "icon-lg", shape: "rounded", className: "rounded-xl" }],
    defaultVariants: { variant: "secondary", size: "sm", shape: "rounded" },
  }
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, shape, asChild = false, type, ...props }, ref) => {
    const Comp = asChild ? Slot : "button"
    return <Comp className={cn(buttonVariants({ variant, size, shape, className }))} ref={ref} {...(asChild ? {} : { type: type ?? "button" })} {...props} />
  }
)
Button.displayName = "Button"

export { Button, buttonVariants }
