import { useState, type KeyboardEvent, type ReactNode } from 'react'
import { Pencil } from 'lucide-react'
import { cn } from '@/lib/utils'
import { people, type Conversation } from '@/data'
import { Button } from '@/components/ui/button'
import { Chip } from '@/components/ui/chip'
import { Surface } from '@/components/ui/surface'
import { TextInput } from '@/components/pages/kit/parts'
import { GroupAvatar } from '../Avatar'
import { LAYERS } from './constants'

/* 工作台的小零件:卡片、来源标签、就地编辑、层级说明、整行可点的 div。只管展示和本地编辑态。 */

/** 工作台里的一块:沉在纸面上的浅底,不套卡片阴影(层级靠标题和间距) */
export function WbCard({ children, className, testid }: { children: ReactNode; className?: string; testid?: string }) {
  return (
    <Surface elevation="sunken" data-testid={testid} className={cn('p-4', className)}>
      {children}
    </Surface>
  )
}

/** 来源标签:群头像 + 群名,或「与 X 私聊」;群名过长省略 */
export function Source({ conv }: { conv?: Conversation }) {
  if (!conv) return null
  if (conv.kind === 'dm') {
    const other = conv.members.find((m) => m !== 'me') ?? ''
    return <Chip size="sm" className="max-w-[180px] rounded-full bg-bg text-[11px] font-normal"><span className="truncate">与 {people[other]?.name ?? conv.title} 私聊</span></Chip>
  }
  return (
    <Chip size="sm" className="max-w-[180px] rounded-full bg-bg pl-0.5 text-[11px] font-normal">
      <GroupAvatar ids={conv.members} size={16} /><span className="truncate">{conv.title}</span>
    </Chip>
  )
}

/** 标题旁的一句:这一层谁来写、多久变一次 */
export function LayerHint({ k }: { k: string }) {
  const l = LAYERS.find((x) => x.k === k)
  return l ? <span className="ml-1.5 text-[11.5px] font-normal text-fg-3">{l.who}</span> : null
}

/** 整行可点、里面还有按钮的 div:补上键盘(Enter / 空格)和 focus 环。
    只响应落在行本身上的按键,行内按钮自己的 Enter 不会再触发整行。 */
export function pressRow(action: () => void) {
  return {
    role: 'button' as const,
    tabIndex: 0,
    onClick: action,
    onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => {
      if (e.target !== e.currentTarget) return
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); action() }
    },
  }
}
export const pressRowCls = 'cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-ring/60'

/** 「打开会话」这类弱化的文字链接;不冒泡到整行 */
export function TextLink({ children, onClick, testid, className }: { children: ReactNode; onClick: () => void; testid?: string; className?: string }) {
  return (
    <Button variant="link" size="xs" data-testid={testid} onClick={(e) => { e.stopPropagation(); onClick() }}
      className={cn('h-auto shrink-0 px-0 text-[12px] font-normal text-fg-3 underline-offset-2 hover:text-fg', className)}>
      {children}
    </Button>
  )
}

/** 就地编辑的一行文字:点了变输入框,Enter 保存,Esc 取消 */
export function InlineEdit({ value, onSave, testid, placeholder }: { value: string; onSave: (v: string) => void; testid: string; placeholder?: string }) {
  const [editing, setEditing] = useState(false)
  const [v, setV] = useState(value)
  if (editing)
    return (
      <form className="flex min-w-0 flex-1 items-center gap-1.5" onSubmit={(e) => { e.preventDefault(); onSave(v.trim()); setEditing(false) }}>
        <TextInput dense autoFocus data-testid={`${testid}-input`} value={v} onChange={(e) => setV(e.target.value)} placeholder={placeholder}
          onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setV(value); setEditing(false) } }} className="flex-1" />
        <Button type="submit" variant="primary" size="sm" data-testid={`${testid}-save`}>保存</Button>
        <Button variant="ghost" size="sm" onClick={() => { setV(value); setEditing(false) }}>取消</Button>
      </form>
    )
  return (
    <Button variant="ghost" data-testid={testid} onClick={() => { setV(value); setEditing(true) }}
      className="group/e h-auto min-w-0 flex-1 justify-start gap-1.5 px-1 py-1 text-left text-[13.5px] font-normal text-fg [&_svg]:size-3.5">
      <span className={cn('min-w-0 flex-1 truncate', !value && 'text-fg-3')}>{value || placeholder}</span>
      <Pencil className="text-fg-3 opacity-60 transition-opacity duration-fast group-hover/e:opacity-100" />
    </Button>
  )
}
