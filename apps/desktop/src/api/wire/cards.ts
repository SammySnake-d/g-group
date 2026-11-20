// 卡片接线:后端消息上的卡片 → 界面里「挂在消息下的选项」或「Compute 那一行上的按钮」(同一状态只一个主锚点,F-ONE-ANCHOR)。
//   - 任务失败卡(挂在某件任务上):不在消息下重复出按钮,按钮放在那件 Compute 的那一行上(重试 / 换模型 / 不重试了,AC-36);
//   - 任务受阻的提问卡(Compute 卡在只有人能过的一步):按钮也在 Compute 那一行上(我来处理 / 交还 / 不做了,AC-44),见 tasks.ts 的 needsHuman;
//   - 任务卡(接了任务那句上的「取消任务」):不出按钮,停止在 Compute 分屏里(两步停,AC-23);
//   - 授权提问过期了(你改了前提):选项划掉,写明「已过期·未执行」(AC-19)。
// 这里只把卡片读成界面状态;点了以后怎么调后端在 compute-actions.ts。
import type { MessageView } from '@g-group/api-contract'
import type { Msg, MsgCard, Pending, PersonId } from '@/data'
import type { WireCtx } from './types'

export function cardFields(v: MessageView): { card?: MsgCard; deliverables?: { ref: string; name: string; mime: string; bytes: number }[] } {
  const c = v.card
  return {
    ...(c ? { card: { id: c.cardId, seq: v.seq, kind: c.kind, taskId: c.taskId, state: c.state, title: c.title, body: c.body, actions: c.actions.map((a) => ({ id: a.actionId, label: a.label, style: a.style })) } } : {}),
    ...(v.artifacts?.length ? { deliverables: v.artifacts.map((a) => ({ ref: a.ref, name: a.name, mime: a.mime, bytes: a.bytes })) } : {}),
  }
}

export const isConsent = (c: MsgCard) => c.kind === 'question' && c.actions.some((a) => a.id === 'approve')
export const isTaskFailure = (c: MsgCard) => c.kind === 'failure' && c.taskId !== null
export const cardPid = (cardId: string) => `card:${cardId}`

type CardMsg = Extract<Msg, { k: 'text' }> & { card: MsgCard }
const withCard = (m: Msg): m is CardMsg => m.k === 'text' && !!m.card

export function pendingOf(roomId: string, m: CardMsg): Pending | null {
  const c = m.card
  const from = m.from as PersonId
  if (c.kind === 'task-status' || c.kind === 'delivery') return null
  if (isTaskFailure(c)) return c.state === 'open' ? { kind: 'error', id: cardPid(c.id), conv: roomId, from, computeId: c.taskId! } : null
  if (c.kind === 'question' && !isConsent(c)) return null
  const stale = c.state === 'expired' && isConsent(c)
  if ((c.state !== 'open' && !stale) || !c.actions.length) return null
  const primary = c.actions.findIndex((a) => a.style === 'primary')
  return { kind: 'choice', id: cardPid(c.id), conv: roomId, from, ask: m.id, title: c.title, options: c.actions.map((a) => a.label), ...(primary >= 0 ? { recommend: primary } : {}), ...(stale ? { stale: '已过期·未执行' } : {}) }
}

export function syncCards(w: WireCtx, roomId: string) {
  const conv = w.get().convs.find((c) => c.id === roomId)
  if (!conv) return
  const mine = conv.messages.filter(withCard).flatMap((m) => pendingOf(roomId, m) ?? [])
  w.get().putCardPending(roomId, mine)
}

export function findCard(convs: readonly { id: string; messages: Msg[] }[], match: (c: MsgCard) => boolean): { roomId: string; msg: CardMsg } | null {
  for (const conv of convs) {
    for (let i = conv.messages.length - 1; i >= 0; i--) {
      const m = conv.messages[i]!
      if (withCard(m) && match(m.card)) return { roomId: conv.id, msg: m }
    }
  }
  return null
}
