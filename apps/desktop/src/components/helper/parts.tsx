import type { ReactNode } from 'react'
import { ArrowUp, Check } from 'lucide-react'
import { motion, useReducedMotion } from 'motion/react'
import { cn } from '@/lib/utils'
import { HELPER_MARK } from '@/config/brand'
import { IconButton } from '@/components/ui/icon-button'
import { appear } from '@/components/pages/kit/motion'
import { Bot } from '../Avatar'

/* Helper 面板与全局 Helper 共用的零件:标识、气泡、输入框、确认卡外壳 */

/** Helper 的标识:灯泡形状 + 品牌色,和联系人头像同一套 */
export const Bulb = ({ size = 22 }: { size?: number }) => <Bot shape={HELPER_MARK.shape} color={HELPER_MARK.color} size={size} />

export function Bubble({ from, children }: { from: 'me' | 'helper'; children: ReactNode }) {
  if (from === 'me') return <div className="flex justify-end"><div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-me px-3 py-2 text-[13.5px] text-me-fg">{children}</div></div>
  return (
    <div className="flex gap-2">
      <div className="mt-0.5 shrink-0"><Bulb size={22} /></div>
      <div className="min-w-0 flex-1 whitespace-pre-wrap text-[13.5px] leading-relaxed">{children}</div>
    </div>
  )
}

/** 输入框:Enter 发送、Shift+Enter 换行、输入法组字时不发 */
export function AskBox({ value, onChange, onSend, placeholder, testid, sendTestid }: { value: string; onChange: (v: string) => void; onSend: () => void; placeholder: string; testid: string; sendTestid: string }) {
  const can = !!value.trim()
  return (
    <div className="flex items-end gap-2 rounded-xl border border-line bg-bg px-3 py-2 transition-[border-color] duration-fast ease-out focus-within:border-fg-3">
      <textarea
        data-testid={testid}
        value={value}
        rows={1}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); onSend() }
        }}
        className="max-h-32 min-h-[22px] flex-1 resize-none bg-transparent text-[14px] leading-[22px] outline-none placeholder:text-fg-3"
      />
      <IconButton data-testid={sendTestid} label="发送" tooltip={false} onClick={onSend} disabled={!can} size="icon-sm" variant={can ? 'primary' : 'secondary'} icon={<ArrowUp />} />
    </div>
  )
}

/** 确认卡:标题 / 内容 / 操作三段,完成后底部一行灰字说明结果 */
export function ConfirmCard({ title, children, done, className }: { title: ReactNode; children: ReactNode; done?: ReactNode; className?: string }) {
  const reduced = useReducedMotion()
  return (
    <motion.div {...(reduced ? {} : appear)} className={cn('mt-2 overflow-hidden rounded-xl border border-line bg-bg', className)}>
      <div className="border-b border-line px-3 py-2 text-[12.5px] font-medium text-fg-2">{title}</div>
      <div className="px-3 py-3 text-[13.5px]">{children}</div>
      {done && <div className="flex items-center gap-1.5 border-t border-line px-3 py-2 text-[12.5px] text-fg-3"><Check className="h-3.5 w-3.5 shrink-0 text-ok" />{done}</div>}
    </motion.div>
  )
}

/** 卡片里的小标题(「拉谁」「带哪几条当背景」) */
export const CardLabel = ({ children, className }: { children: ReactNode; className?: string }) => (
  <div className={cn('mt-3 text-[12px] text-fg-3 first:mt-0', className)}>{children}</div>
)
