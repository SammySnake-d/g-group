/* A2UI 提问卡片的状态与选项(纯计算,界面在 AskCard / AskOption)。
   一张卡三种状态:open 等你选 / stale 你后面改了前提、选项作废 / answered 你选过了。 */
import type { Pending } from '@/data'
import { useApp, type Answer } from '@/ctx'
import type { TextMsg } from '../types'

export type AskOpt = { label: string; primary?: boolean; run?: () => void }
export type AskState = 'open' | 'stale' | 'answered'

/** 选项都短(≤3 个、每个 ≤8 字)就排成一行小按钮;否则每项占一整行(#823:选项一长,排成气泡就难看) */
export const isShort = (opts: string[]) => opts.length <= 3 && opts.every((o) => o.length <= 8)

type Asking = Extract<Pending, { kind: 'choice' | 'proposal' }>

/** 把待你处理的提问(或已经回答过的记录)变成卡片上的一排选项;只有等你选时选项才带动作 */
export function askOptions(p: Asking | undefined, done: Answer | undefined, resolve: (pid: string, action: string, value?: number) => void): AskOpt[] {
  if (!p) return done ? done.options.map((o) => ({ label: o })) : []
  if (p.kind === 'choice') return p.options.map((o, i) => ({ label: o, primary: i === (p.recommend ?? -1), run: () => resolve(p.id, 'pick', i) }))
  if (p.gate) return [{ label: '同意，改吧', primary: true, run: () => resolve(p.id, 'ok') }, { label: '先别改', run: () => resolve(p.id, 'no') }]
  return [{ label: '同意', primary: true, run: () => resolve(p.id, 'ok') }, { label: '先不改', run: () => resolve(p.id, 'no') }]
}

/** 挂在消息 msgId 下的提问卡片;没有提问也没有回答记录时返回 null */
export function useAsk(msgId: string) {
  const { pending, resolve, addQuote, convs, answers } = useApp()
  const p = pending.find((x): x is Asking => (x.kind === 'choice' || x.kind === 'proposal') && x.ask === msgId)
  const done = answers[msgId]
  if (!p && !done) return null
  const stale = p?.kind === 'choice' ? p.stale : undefined
  const live = !!p && !stale
  const state: AskState = live ? 'open' : stale ? 'stale' : 'answered'
  const opts = askOptions(p, done, resolve)
  /** 都不是:引用这条提问并 @ 提问的人,你自己写回答 */
  const answerOwn = () => {
    for (const c of convs) {
      const m = c.messages.find((x): x is TextMsg => x.k === 'text' && x.id === msgId)
      if (m) return addQuote({ msgId, from: m.from, text: m.text.replace(/^@\S+\s/, ''), reply: true })
    }
  }
  return { title: p ? p.title : done!.title, state, live, stale, done, opts, short: isShort(opts.map((o) => o.label)), answerOwn }
}
