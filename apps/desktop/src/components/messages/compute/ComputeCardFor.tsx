/* 完整过程面板(compact 消息流)里的 Compute:接上 store 的 ComputeCard。
   展示在 components/compute;这里只把状态和动作(重试 / 换模型 / 跳过、我来输入 / 交还 / 不做了、打开会话)接进去。
   原始会话记录现在取演示数据,后端合同补上「按 computeId 分页取原始事件」后换成接口。 */
import type { MouseEvent } from 'react'
import { Zap } from 'lucide-react'
import { useApp } from '@/ctx'
import { broken } from '@/mut'
import { Button } from '@/components/ui/button'
import { ComputeCard, DEMO_NOW, demoSession, type CardActions } from '@/components/compute'
import { cn } from '@/lib/utils'
import { useComputeView } from './useComputeView'

export const OPEN_SESSION = '打开会话'

/** 打开分屏并选中「会话」页签 */
export function useOpenSession(id: string) {
  const { openSplit } = useApp()
  return () => openSplit({ t: 'compute', id, view: 'session' })
}

/** 消息行末端的「打开会话」:指针读完这一行自然落到这里(#1032),不冒泡到整行的点击 */
export function OpenSessionButton({ id, className }: { id: string; className?: string }) {
  const open = useOpenSession(id)
  return (
    <Button data-testid={`open-session-${id}`} variant="ghost" size="xs" onClick={(e: MouseEvent) => { e.stopPropagation(); open() }}
      className={cn('h-6 shrink-0 gap-1 px-1.5 text-[12px] font-normal text-fg-3 hover:text-fg [&_svg]:size-3', className)}>
      <Zap />{OPEN_SESSION}
    </Button>
  )
}

export function ComputeCardFor({ id }: { id: string }) {
  const { resolve, takeHuman, returnHuman, declineHuman } = useApp()
  const v = useComputeView(id)
  const open = useOpenSession(id)
  if (!v) return null
  const { c, err } = v
  const actions: CardActions = {
    ...(err ? { retry: () => resolve(err.id, 'retry') } : {}),
    ...(err && !broken('AC-36') ? { switchModel: () => resolve(err.id, 'switch'), skip: () => resolve(err.id, 'skip') } : {}),
    takeHuman: () => takeHuman(id),
    returnHuman: () => returnHuman(id),
    declineHuman: () => declineHuman(id),
  }
  return <ComputeCard compute={c} transcript={demoSession(id)} now={DEMO_NOW} onOpenSession={open} actions={actions} />
}
