import type { CSSProperties } from "react"
import { Toaster as Sonner, type ToasterProps } from "sonner"

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
