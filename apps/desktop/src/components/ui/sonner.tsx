import type { CSSProperties } from "react"
import { Toaster as Sonner, type ToasterProps } from "sonner"

/* 提示条原语:sonner(Emil Kowalski)。进出场、堆叠、悬停暂停、划走关闭都用它自带的,不另写动效;
   颜色、边框、圆角、阴影换成产品 token,亮暗跟着 theme 走。 */
const tokens = {
  "--normal-bg": "hsl(var(--elev))",
  "--normal-text": "hsl(var(--fg))",
  "--normal-border": "hsl(var(--line))",
  "--border-radius": "var(--radius)",
} as CSSProperties

export function Toaster({ style, toastOptions, ...props }: ToasterProps) {
  return (
    <Sonner
      containerAriaLabel="通知"
      style={{ ...tokens, ...style }}
      toastOptions={{
        ...toastOptions,
        classNames: {
          toast: "![font-family:inherit] !shadow-elev",
          title: "!font-normal text-[13px]",
          actionButton: "!bg-btn !text-btn-fg !font-medium",
          ...toastOptions?.classNames,
        },
      }}
      {...props}
    />
  )
}

export type { ToasterProps }
