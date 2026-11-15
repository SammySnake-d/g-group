// 卡片接线:后端消息上的卡片 → 界面里「挂在消息下的选项」或「Compute 那一行上的按钮」(同一状态只一个主锚点,F-ONE-ANCHOR)。
//   - 任务失败卡(挂在某件任务上):不在消息下重复出按钮,按钮放在那件 Compute 的那一行上(重试 / 换模型 / 不重试了,AC-36);
//   - 任务受阻的提问卡(Compute 卡在只有人能过的一步):按钮也在 Compute 那一行上(我来处理 / 交还 / 不做了,AC-44),见 tasks.ts 的 needsHuman;
//   - 任务卡(接了任务那句上的「取消任务」):不出按钮,停止在 Compute 分屏里(两步停,AC-23);
//   - 其余开着的卡(联系人转来的授权提问、联系人一轮失败、上游暂停的群级卡…):选项挂在那条消息下面,点了走 cards.act;
//   - 授权提问过期了(你改了前提):选项划掉,写明「已过期·未执行」(AC-19)。
// 这里只把卡片读成界面状态;点了以后怎么调后端在 compute-actions.ts。
import type { MessageView } from '@g-group/api-contract'
import type { Msg, MsgCard, Pending, PersonId } from '@/data'
import type { WireCtx } from './types'

/** 合同消息上的卡片和交付工件 → 界面消息上的字段(没有就不带) */
export function cardFields(v: MessageView): { card?: MsgCard; deliverables?: { ref: string; name: string; mime: string; bytes: number }[] } {
  const c = v.card
  return {
    ...(c ? { card: { id: c.cardId, seq: v.seq, kind: c.kind, taskId: c.taskId, state: c.state, title: c.title, body: c.body, actions: c.actions.map((a) => ({ id: a.actionId, label: a.label, style: a.style })) } } : {}),
    ...(v.artifacts?.length ? { deliverables: v.artifacts.map((a) => ({ ref: a.ref, name: a.name, mime: a.mime, bytes: a.bytes })) } : {}),
  }
}

/** 授权提问(同意 / 不同意):联系人在聊天里转来的审批 */
export const isConsent = (c: MsgCard) => c.kind === 'question' && c.actions.some((a) => a.id === 'approve')
/** 挂在任务上的失败卡:按钮在 Compute 那一行 */
export const isTaskFailure = (c: MsgCard) => c.kind === 'failure' && c.taskId !== null
/** 卡片对应的「待你处理」号 */
export const cardPid = (cardId: string) => `card:${cardId}`

type CardMsg = Extract<Msg, { k: 'text' }> & { card: MsgCard }
const withCard = (m: Msg): m is CardMsg => m.k === 'text' && !!m.card

/** 一条带卡片的消息要不要在界面上等你处理;不用就是 null */
export function pendingOf(roomId: string, m: CardMsg): Pending | null {
  const c = m.card
  const from = m.from as PersonId
  if (c.kind === 'task-status' || c.kind === 'delivery') return null
  if (isTaskFailure(c)) return c.state === 'open' ? { kind: 'error', id: cardPid(c.id), conv: roomId, from, computeId: c.taskId! } : null
  /* 任务受阻的提问(回答 / 不做了):在 Compute 那一行上处理 */
  if (c.kind === 'question' && !isConsent(c)) return null
  const stale = c.state === 'expired' && isConsent(c)
  if ((c.state !== 'open' && !stale) || !c.actions.length) return null
  const primary = c.actions.findIndex((a) => a.style === 'primary')
  return { kind: 'choice', id: cardPid(c.id), conv: roomId, from, ask: m.id, title: c.title, options: c.actions.map((a) => a.label), ...(primary >= 0 ? { recommend: primary } : {}), ...(stale ? { stale: '已过期·未执行' } : {}) }
}

/** 按这个会话现在的消息重算它的「待你处理」(只动卡片来的那几条,别的不碰) */
export function syncCards(w: WireCtx, roomId: string) {
  const conv = w.get().convs.find((c) => c.id === roomId)
  if (!conv) return
  const mine = conv.messages.filter(withCard).flatMap((m) => pendingOf(roomId, m) ?? [])
  w.get().putCardPending(roomId, mine)
}

/** 在所有会话里找这张卡和它所在的消息 */
export function findCard(convs: readonly { id: string; messages: Msg[] }[], match: (c: MsgCard) => boolean): { roomId: string; msg: CardMsg } | null {
  for (const conv of convs) {
    for (let i = conv.messages.length - 1; i >= 0; i--) {
      const m = conv.messages[i]!
      if (withCard(m) && match(m.card)) return { roomId: conv.id, msg: m }
    }
  }
  return null
}
