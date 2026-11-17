import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

/* 承载面原语:卡片、浮层、输入框外壳。半透明细边 + 两层阴影(Vercel「Crisp borders」「Layered shadows」);
   嵌套时子圆角 ≤ 父圆角(radius 档位随层级往下取)。不要卡片套卡片。 */
const surfaceVariants = cva("relative", {
  variants: {
    elevation: {
      flat: "border border-line bg-elev",
      raised: "border border-line bg-elev shadow-soft",
      floating: "border border-line bg-elev shadow-elev",
      sunken: "bg-hover/60",
    },
    radius: { md: "rounded-lg", lg: "rounded-xl", xl: "rounded-2xl" },
    interactive: { true: "transition-[border-color,box-shadow,background-color] duration-fast ease-out hover:border-fg-3/40 focus-within:border-fg-3/50", false: "" },
  },
  defaultVariants: { elevation: "raised", radius: "xl", interactive: false },
})

export interface SurfaceProps extends React.HTMLAttributes<HTMLDivElement>, VariantProps<typeof surfaceVariants> {}

export const Surface = React.forwardRef<HTMLDivElement, SurfaceProps>(({ className, elevation, radius, interactive, ...props }, ref) => (
  <div ref={ref} className={cn(surfaceVariants({ elevation, radius, interactive }), className)} {...props} />
))
Surface.displayName = "Surface"
export { surfaceVariants }
