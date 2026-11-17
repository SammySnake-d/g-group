import * as React from "react"
import * as DropdownMenuPrimitive from "@animate-ui/react/primitives/radix-ui/dropdown-menu"
import { cva } from "class-variance-authority"
import { AlertCircle, Check, ChevronDown } from "lucide-react"

import { cn } from "@/lib/utils"
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "./dropdown-menu"

/* 表单行原语:标签、说明、控件、错误。
   Field 生成 id 并通过上下文交给里面的控件,标签用 htmlFor 指向控件,说明 / 错误用 aria-describedby 挂上(Vercel「Forms」)。
   layout=stack:标签在上(编辑器、对话框);layout=inline:标签和说明在左、控件在右(设置行)。
   group=true:控件不止一个(芯片组、分段切换)时,标签变成这一组的名字(role=group + aria-labelledby),不再把 id 发给里面的控件。 */

type FieldCtx = { id: string; describedBy?: string; invalid: boolean }
const FieldContext = React.createContext<FieldCtx | null>(null)
export const useField = () => React.useContext(FieldContext)

export interface FieldProps {
  label: React.ReactNode
  hint?: React.ReactNode
  error?: React.ReactNode
  layout?: "stack" | "inline"
  group?: boolean
  className?: string
  children: React.ReactNode
  "data-testid"?: string
}

export function Field({ label, hint, error, layout = "stack", group, className, children, ...rest }: FieldProps) {
  const id = React.useId()
  const hintId = hint ? `${id}-hint` : undefined
  const errId = error ? `${id}-err` : undefined
  const ctx: FieldCtx | null = group ? null : { id, describedBy: [hintId, errId].filter(Boolean).join(" ") || undefined, invalid: !!error }
  const L = group ? "span" : "label"
  const labelEl = <L id={`${id}-label`} {...(group ? {} : { htmlFor: id })} className={cn(layout === "stack" ? "text-[12.5px] font-semibold text-fg" : "block text-[13.5px] text-fg")}>{label}</L>
  const err = error && <p id={errId} role="alert" className="mt-1.5 flex items-start gap-1.5 text-[12px] leading-snug text-err"><AlertCircle className="mt-px h-3.5 w-3.5 shrink-0" />{error}</p>
  const groupProps = group ? { role: "group", "aria-labelledby": `${id}-label` } : {}
  if (layout === "inline") {
    return (
      <div className={cn("min-w-0", className)} {...groupProps} {...rest}>
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">{labelEl}{hint && <p id={hintId} className="text-[11.5px] leading-snug text-fg-3">{hint}</p>}</div>
          <FieldContext.Provider value={ctx}>{children}</FieldContext.Provider>
        </div>
        {err}
      </div>
    )
  }
  return (
    <div className={cn("min-w-0", className)} {...groupProps} {...rest}>
      <div className="mb-1.5 flex min-w-0 items-baseline gap-2">{labelEl}{hint && <span id={hintId} className="min-w-0 truncate text-[11.5px] text-fg-3">{hint}</span>}</div>
      <FieldContext.Provider value={ctx}>{children}</FieldContext.Provider>
      {err}
    </div>
  )
}

/* ---------------------------------------------------------------- 控件外观 */

export const controlVariants = cva(
  "w-full min-w-0 rounded-lg border bg-bg text-fg outline-none transition-[border-color,box-shadow] duration-fast ease-out placeholder:text-fg-3 hover:border-fg-3/50 focus-visible:border-fg-3 focus-visible:ring-2 focus-visible:ring-ring/25 disabled:cursor-not-allowed disabled:opacity-50",
  {
    variants: {
      size: { sm: "h-8 px-2.5 text-[13px]", md: "h-9 px-3 text-[13.5px]", lg: "h-10 px-3 text-[13.5px]" },
      invalid: { true: "border-err hover:border-err focus-visible:border-err focus-visible:ring-err/25", false: "border-line" },
    },
    defaultVariants: { size: "md", invalid: false },
  }
)
type ControlSize = "sm" | "md" | "lg"

/** 控件从 Field 拿 id / 说明 / 是否出错;自己传的优先 */
function useControl(id?: string, invalid?: boolean, describedBy?: string) {
  const f = useField()
  const bad = invalid ?? f?.invalid ?? false
  return { id: id ?? f?.id, invalid: bad, "aria-invalid": bad || undefined, "aria-describedby": describedBy ?? f?.describedBy }
}

export interface InputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "size"> { size?: ControlSize; invalid?: boolean }
export const Input = React.forwardRef<HTMLInputElement, InputProps>(({ className, size, invalid, id, "aria-describedby": d, ...props }, ref) => {
  const { invalid: bad, ...a } = useControl(id, invalid, d)
  return <input ref={ref} {...a} className={cn(controlVariants({ size, invalid: bad }), className)} {...props} />
})
Input.displayName = "Input"

export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> { invalid?: boolean }
export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(({ className, invalid, id, "aria-describedby": d, ...props }, ref) => {
  const { invalid: bad, ...a } = useControl(id, invalid, d)
  return <textarea ref={ref} {...a} className={cn(controlVariants({ invalid: bad }), "h-auto py-2 leading-relaxed", className)} {...props} />
})
Textarea.displayName = "Textarea"

/** 原生下拉:测试和无障碍都按原生 select 走(键盘、系统菜单),外观和其它控件一致。className 落在外壳上(管宽度) */
export interface NativeSelectProps extends Omit<React.SelectHTMLAttributes<HTMLSelectElement>, "size"> { size?: ControlSize; invalid?: boolean }
export const NativeSelect = React.forwardRef<HTMLSelectElement, NativeSelectProps>(({ className, size = "sm", invalid, id, "aria-describedby": d, children, ...props }, ref) => {
  const { invalid: bad, ...a } = useControl(id, invalid, d)
  return (
    <span className={cn("relative inline-flex min-w-0", className)}>
      <select ref={ref} {...a} className={cn(controlVariants({ size, invalid: bad }), "appearance-none truncate pr-7", bad && "text-err")} {...props}>{children}</select>
      <ChevronDown aria-hidden className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-fg-3" />
    </span>
  )
})
NativeSelect.displayName = "NativeSelect"

/* ---------------------------------------------------------------- 菜单式下拉(Radix DropdownMenu)
   选项少、要带说明、或者不需要原生行为的单选:触发器长得像输入框,菜单从触发器方向长出(origin-aware),方向键 / 字母跳转 / Esc。 */

export interface SelectMenuOption<T extends string> { value: T; label: React.ReactNode; hint?: React.ReactNode; disabled?: boolean }

export function SelectMenu<T extends string>({ value, onChange, options, placeholder = "选一个", size = "md", invalid, className, testid, label, align = "start" }: {
  value: T | "" | undefined
  onChange: (v: T) => void
  options: readonly SelectMenuOption<T>[]
  placeholder?: React.ReactNode
  size?: ControlSize
  invalid?: boolean
  className?: string
  testid?: string
  /** 没有 Field 包着时的无障碍名 */
  label?: string
  align?: "start" | "end"
}) {
  const { invalid: bad, ...a } = useControl(undefined, invalid)
  const cur = options.find((o) => o.value === value)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" data-testid={testid} aria-label={label} {...a}
          className={cn(controlVariants({ size, invalid: bad }), "group inline-flex items-center gap-2 pr-2.5 text-left data-[state=open]:border-fg-3", className)}>
          <span className={cn("min-w-0 flex-1 truncate", !cur && "text-fg-3")}>{cur ? cur.label : placeholder}</span>
          <ChevronDown aria-hidden className="h-3.5 w-3.5 shrink-0 text-fg-3 transition-transform duration-fast ease-out group-data-[state=open]:rotate-180" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align={align} className="min-w-[var(--radix-dropdown-menu-trigger-width)] max-w-[360px] rounded-xl border-line bg-elev p-1 text-fg shadow-elev">
        <DropdownMenuPrimitive.RadioGroup value={value ?? ""} onValueChange={(v) => onChange(v as T)}>
          {options.map((o) => (
            <DropdownMenuPrimitive.RadioItem key={o.value} value={o.value} disabled={o.disabled} data-testid={testid ? `${testid}-${o.value}` : undefined}
              className="relative flex cursor-default select-none items-center gap-2 rounded-lg py-1.5 pl-7 pr-2.5 text-[13px] outline-none data-[disabled]:opacity-45 data-[highlighted]:bg-hover data-[state=checked]:font-medium">
              <span className="absolute left-2 grid h-3.5 w-3.5 place-items-center"><DropdownMenuPrimitive.ItemIndicator><Check className="h-3.5 w-3.5" /></DropdownMenuPrimitive.ItemIndicator></span>
              <span className="min-w-0 flex-1 truncate">{o.label}</span>
              {o.hint && <span className="max-w-[45%] shrink-0 truncate text-[11.5px] font-normal text-fg-3">{o.hint}</span>}
            </DropdownMenuPrimitive.RadioItem>
          ))}
        </DropdownMenuPrimitive.RadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
