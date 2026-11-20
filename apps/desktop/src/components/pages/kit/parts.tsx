import { forwardRef, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from 'react'
import { cn } from '@/lib/utils'


export function PageScroll({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('scroll-thin min-h-0 flex-1 overflow-y-auto pb-4', className)} style={{ ['--avatar-ring' as string]: 'var(--elev)' }}>
      {children}
    </div>
  )
}

export function Hint({ children, className, testid }: { children: ReactNode; className?: string; testid?: string }) {
  return <p data-testid={testid} className={cn('text-[12.5px] leading-relaxed text-fg-3 [text-wrap:pretty]', className)}>{children}</p>
}

export function Subhead({ children, className, right }: { children: ReactNode; className?: string; right?: ReactNode }) {
  return (
    <div className={cn('mb-1 mt-3 flex items-center gap-2 first:mt-0', className)}>
      <h4 className="min-w-0 flex-1 truncate text-[12px] font-medium text-fg-3">{children}</h4>
      {right}
    </div>
  )
}

export const ctaDisabled = 'disabled:bg-hover disabled:text-fg-3 disabled:opacity-100 disabled:shadow-none'

export function PageFooter({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('shrink-0 border-t border-line p-3', className)}>{children}</div>
}

export const inputCls =
  'h-10 w-full min-w-0 rounded-lg border border-line bg-bg px-3 text-[14px] outline-none transition-[border-color,box-shadow] duration-fast ease-out placeholder:text-fg-3 focus-visible:border-fg-3 focus-visible:ring-2 focus-visible:ring-ring/25 disabled:opacity-60'

export const TextInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { size?: never; dense?: boolean }>(({ className, dense, ...props }, ref) => (
  <input ref={ref} className={cn(inputCls, dense && 'h-8 px-2.5 text-[13px]', className)} {...props} />
))
TextInput.displayName = 'TextInput'

export const TextArea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(({ className, ...props }, ref) => (
  <textarea ref={ref} className={cn(inputCls, 'h-auto resize-y py-2 text-[13.5px] leading-relaxed', className)} {...props} />
))
TextArea.displayName = 'TextArea'

export function Field({ label, children, className, aside }: { label: ReactNode; children: ReactNode; className?: string; aside?: ReactNode }) {
  return (
    <label className={cn('block', className)}>
      <span className="mb-1 flex items-center justify-between text-[12.5px] font-medium text-fg-2">{label}{aside}</span>
      {children}
    </label>
  )
}
