import * as React from "react"
import * as DialogPrimitive from "@animate-ui/react/primitives/radix-ui/dialog"
import { X } from "lucide-react"

import { cn } from "@/lib/utils"
import { IconButton } from "./icon-button"


type Side = DialogPrimitive.DialogFlipDirection
let lastPress: { x: number; y: number; t: number } | null = null
if (typeof window !== "undefined") {
  window.addEventListener("pointerdown", (e) => { lastPress = { x: e.clientX, y: e.clientY, t: performance.now() } }, true)
}
function triggerSide(): Side {
  let p: { x: number; y: number } | null = null
  if (lastPress && performance.now() - lastPress.t < 1000) p = lastPress
  else {
    const el = document.activeElement
    if (el && el !== document.body) { const r = el.getBoundingClientRect(); p = { x: r.left + r.width / 2, y: r.top + r.height / 2 } }
  }
  if (!p) return "top"
  const dx = p.x - window.innerWidth / 2
  const dy = p.y - window.innerHeight / 2
  return Math.abs(dy) >= Math.abs(dx) ? (dy > 0 ? "bottom" : "top") : dx > 0 ? "right" : "left"
}
function useOpenSide(open: boolean): Side {
  const was = React.useRef(false)
  const side = React.useRef<Side>("top")
  if (open && !was.current) side.current = triggerSide()
  was.current = open
  return side.current
}

export function useExitValue<T>(v: T | null | undefined): T | null {
  const ref = React.useRef<T | null>(null)
  if (v != null) ref.current = v
  return ref.current
}

type ContentProps = Omit<DialogPrimitive.DialogContentProps, "title" | "children" | "asChild" | "forceMount" | "from" | "transition" | "exitTransition">

export interface ModalProps extends ContentProps {
  open: boolean
  onClose: () => void
  title: React.ReactNode
  description?: React.ReactNode
  /** 标题左边的图标(插件图标、状态圆标) */
  icon?: React.ReactNode
  width?: number
  testid?: string
  closeLabel?: string
  children: React.ReactNode
}

export function Modal({ open, onClose, title, description, icon, width = 520, testid, closeLabel = "关闭", className, style, children, ...content }: ModalProps) {
  const from = useOpenSide(open)
  return (
    <DialogPrimitive.Root open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/30 dark:bg-black/55" />
        <DialogPrimitive.Content from={from} data-testid={testid} {...(description ? {} : { "aria-describedby": undefined })} {...content}
          style={{ ...style, maxWidth: width }}
          className={cn("fixed inset-0 z-50 m-auto flex h-fit max-h-[min(86vh,calc(100vh-48px))] w-[calc(100vw-48px)] flex-col overflow-hidden rounded-2xl border border-line bg-elev text-fg shadow-elev outline-none", className)}>
          <header className="flex items-start gap-3 px-6 pb-1 pr-14 pt-5">
            {icon}
            <div className="min-w-0 flex-1">
              <DialogPrimitive.Title className="text-balance text-[16px] font-semibold leading-snug tracking-[-0.01em]">{title}</DialogPrimitive.Title>
              {description && <DialogPrimitive.Description asChild><div className="mt-1 text-pretty text-[13px] leading-relaxed text-fg-2">{description}</div></DialogPrimitive.Description>}
            </div>
          </header>
          {children}
          <DialogPrimitive.Close asChild>
            <IconButton label={closeLabel} tooltip={false} className="absolute right-3 top-3.5 text-fg-3" icon={<X />} />
          </DialogPrimitive.Close>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

export function ModalBody({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("scroll-thin min-h-0 flex-1 overflow-y-auto px-6 pb-1 pt-3", className)} {...props} />
}

/** 底栏:左边放状态 / 计数,右边放操作(取消在前、主操作最右) */
export function ModalFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("mt-4 flex items-center gap-2 border-t border-line bg-hover/40 px-6 py-3", className)} {...props} />
}
