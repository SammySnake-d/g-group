// 全局提示的唯一入口:状态动作里的 toast(text) 都走这里,底层是 sonner。
import { createElement } from 'react'
import { toast as sonner } from 'sonner'
import { create } from 'zustand'

export type NotifyOptions = { action?: { label: string; onClick: () => void } }

/* 只有最新那条提示带 data-testid="toast":旧提示还在堆叠或退场时,不和新提示抢同一个锚点 */
const useLatest = create<{ id: number }>(() => ({ id: 0 }))
let seq = 0

function ToastText({ id, text }: { id: number; text: string }) {
  const latest = useLatest((s) => s.id)
  return createElement('span', { 'data-testid': latest === id ? 'toast' : undefined }, text)
}

export function notify(text: string, opts?: NotifyOptions) {
  const id = ++seq
  useLatest.setState({ id })
  sonner(createElement(ToastText, { id, text }), { id, ...opts })
}

/** 兼容旧的 shadcn 写法:toast({ title }) / useToast().toast(...) */
export function toast(t: string | { title?: string; description?: string }) {
  notify(typeof t === 'string' ? t : [t.title, t.description].filter(Boolean).join(' · '))
}
export const useToast = () => ({ toast, dismiss: (id?: number) => sonner.dismiss(id) })
