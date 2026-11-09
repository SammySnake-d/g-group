import type { ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'
import type { ToolKind } from '@g-group/ui-core'
import { cn } from '@/lib/utils'
import { TOOL_ICON } from './constants'

/* 会话窗口与卡片共用的小部件，样式照 mirasim 会话窗口（dxe / M7 / R0 / rm 几个组件）的尺寸移植：
   行 12px、等宽 11px、图标 13px、展开箭头 11px 粗 2.4、展开后正文缩进 25px。颜色换成纸·墨·柿 token。 */

/** 整行可点的折叠触发区（#1032：展开的触发区整行可点）。焦点环与按钮原语一致 */
export const rowTrigger =
  'group/row flex min-h-6 w-full min-w-0 items-center gap-1.5 rounded-md text-left transition-colors duration-fast ease-out hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60'

/** 展开箭头：收起朝右，展开转 90°(mirasim pi)；转动时长取库 token */
export function Caret({ className }: { className?: string }) {
  return <ChevronRight aria-hidden strokeWidth={2.4} className={cn('size-[11px] shrink-0 text-fg-3 transition-transform duration-fast ease-out group-data-[state=open]/row:rotate-90', className)} />
}

export type IconTone = 'dim' | 'active' | 'err'
const ICON_TONE: Record<IconTone, string> = { dim: 'text-fg-3', active: 'text-run', err: 'text-err' }

export function KindIcon({ kind, tone = 'dim', className }: { kind: ToolKind; tone?: IconTone; className?: string }) {
  const I = TOOL_ICON[kind]
  return <I aria-hidden strokeWidth={2} className={cn('size-[13px] shrink-0', ICON_TONE[tone], className)} />
}

/** 改动行数：+N 绿、-N 红(mirasim R0) */
export function DiffStat({ added, removed, className }: { added: number; removed: number; className?: string }) {
  return (
    <span className={cn('shrink-0 font-code text-[11px] leading-none tabular-nums', className)} aria-label={`增 ${added} 行，删 ${removed} 行`}>
      <span className="text-ok">+{added}</span> <span className="text-err">-{removed}</span>
    </span>
  )
}

/** 一串用「·」隔开的事实（mirasim 子代理行右侧）：等宽、不换行 */
export function Facts({ items, mono = true, className }: { items: { key: string; text: ReactNode; className?: string }[]; mono?: boolean; className?: string }) {
  return (
    <span className={cn('shrink-0 whitespace-nowrap text-[11px] tabular-nums text-fg-3', mono && 'font-code', className)}>
      {items.map((f, i) => (
        <span key={f.key} className={f.className}>
          {i > 0 && <span aria-hidden className="text-fg-3/50"> · </span>}
          {f.text}
        </span>
      ))}
    </span>
  )
}

/** 展开区里的小节：小标签 + 计数 + 内容(mirasim rm) */
export function Field({ label, count, children, className }: { label: string; count?: number; children: ReactNode; className?: string }) {
  return (
    <div className={cn('min-w-0 px-2 py-1', className)}>
      <div className="mb-0.5 flex items-baseline gap-1.5 text-[11px] text-fg-3">
        <span>{label}</span>
        {count !== undefined && <span className="font-code tabular-nums">{count}</span>}
      </div>
      {children}
    </div>
  )
}

/** 等宽的输入/输出原文：保留换行，太长在框里滚 */
export function Mono({ text, className }: { text: string; className?: string }) {
  return <pre className={cn('scroll-thin max-h-[180px] overflow-auto whitespace-pre-wrap break-words font-code text-[11px] leading-[1.55] text-fg-2', className)}>{text}</pre>
}
