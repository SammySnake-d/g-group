// 连上后端时 Compute 与「等你处理」的写动作(compute 切片在 live 时转到这里;没连上时切片照旧走本地演示)。
// Compute 只读(AC-03):你不直接对它说话——停止走任务取消(两步:先「正在停止」,确认停了才归还,AC-23)、
// 继续走运行台账重跑(用户本人明确发起)、补一句就是在会话里 @ 派它的联系人;卡在只有人能过的一步时,
// 交还 = 回答那个问题(tasks.answer,绑定 q_id),不做了 = 提问卡上的「不做了」(取消并停 Compute,AC-44 ④);
// 失败卡上的重试 / 换模型 / 不重试了、授权提问上的同意 / 不同意都走 cards.act,以你的名义在会话里记一条回复。
import type { Compute } from '@/data'
import { people } from '@/data'
import { cardPid, findCard, isTaskFailure, syncCards } from './cards'
import { putMessages, sendLive } from './messages'
import { toCompute } from './tasks'
import { actionId, type WireCtx } from './types'

const fail = (w: WireCtx, what: string, message: string) => w.get().toast(`没能${what}：${message}`)

/** 点卡片上的一个按钮:成功后把你的那条回复写进会话;失败就说明原因,卡片照旧可点 */
async function act(w: WireCtx, cardId: string, pick: (ids: string[]) => string | undefined, opts: { what: string; text?: string; answered?: (label: string, replyId: string) => void }) {
  const hit = findCard(w.get().convs, (c) => c.id === cardId)
  if (!hit) return fail(w, opts.what, '这张卡已经不在了')
  const { roomId, msg } = hit
  const id = pick(msg.card.actions.map((a) => a.id))
  const action = msg.card.actions.find((a) => a.id === id)
  if (!action) return fail(w, opts.what, '卡上没有这个选项')
  /* 先收起,免得连点;后端拒了再按消息重算回来 */
  w.get().putCardPending(roomId, w.get().pending.filter((p) => p.conv === roomId && p.id.startsWith('card:') && p.id !== cardPid(cardId)))
  const r = await w.call('cards.act', { roomId, seq: msg.card.seq, cardId, actionId: action.id, clientActionId: actionId(), ...(opts.text ? { text: opts.text } : {}) })
  if (!r.ok) { syncCards(w, roomId); return fail(w, opts.what, r.error.message) }
  putMessages(w, roomId, [r.value])
  opts.answered?.(action.label, `${roomId}#${r.value.seq}`)
}

/** 「待你处理」上的选择:失败卡的 retry / switch / skip,其余卡按选项序号 */
export function resolveLive(w: WireCtx, pid: string, action: string, value?: string | number) {
  const cardId = pid.slice('card:'.length)
  const hit = findCard(w.get().convs, (c) => c.id === cardId)
  if (hit && isTaskFailure(hit.msg.card)) {
    const pick = (ids: string[]) => (action === 'retry' ? ids.find((x) => x === 'retry') : action === 'switch' ? ids.find((x) => x.startsWith('switch-model:')) : ids.find((x) => x === 'give-up' || x === 'skip'))
    return act(w, cardId, pick, { what: action === 'retry' ? '重试' : action === 'switch' ? '换模型重试' : '放弃这件' })
  }
  const p = w.get().pending.find((x) => x.id === pid)
  const index = typeof value === 'number' ? value : -1
  return act(w, cardId, (ids) => ids[index], {
    what: '回复这条',
    answered: (label, replyId) => {
      if (p?.kind !== 'choice') return
      w.set((s) => ({ answers: { ...s.answers, [p.ask]: { title: p.title, options: p.options, picked: label, at: new Date().toTimeString().slice(0, 5), replyId } } }))
    },
  })
}

const refresh = (w: WireCtx, t: Parameters<typeof toCompute>[0]) => {
  const c = toCompute(t, w.get().computes[t.id])
  if (c) w.get().putCompute(c)
}

/** 停止:取消这件任务。回包是「正在停止」(T9),确认它启动的程序都退出了才到「已停止」(事件推来) */
export async function stopLive(w: WireCtx, cid: string) {
  const r = await w.call('tasks.cancel', { taskId: cid, clientActionId: actionId() })
  if (!r.ok) return fail(w, '停止', r.error.message)
  refresh(w, r.value)
}

/** 继续:按运行台账重跑这件事最近一次的 Compute 会话(会开一件新任务,联系人在会话里说明) */
export async function resumeLive(w: WireCtx, c: Compute) {
  const l = await w.call('runs.list', { roomId: c.conv })
  if (!l.ok) return fail(w, '继续', l.error.message)
  const session = l.value.runs.filter((u) => u.taskId === c.id && u.layer === 'compute-session').sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0]
  if (!session) return fail(w, '继续', '台账里找不到这件事的 Compute 会话')
  const r = await w.call('runs.rerun', { runId: session.id, clientActionId: actionId() })
  if (!r.ok) return fail(w, '继续', r.error.message)
}

/** 补一句:Compute 不直接收话,在会话里 @ 派它的联系人,引用它接活那句 */
export function tellLive(w: WireCtx, c: Compute, text: string) {
  const conv = w.get().convs.find((x) => x.id === c.conv)
  const lead = conv?.messages.find((m) => m.k === 'compute' && m.computeId === c.id)
  const leadId = lead && 'id' in lead ? lead.id.replace(/~c$/, '') : null
  const name = people[c.owner]?.name ?? ''
  const quotes = leadId ? [{ msgId: leadId, from: c.owner, text: c.title, reply: true }] : []
  return sendLive(w, c.conv, `@${name} ${text}`, quotes)
}

/** 交还:回答它卡住的那一步(绑定这次提问的 q_id;它已经不在等了,后端幂等忽略,界面如实说) */
export async function returnHumanLive(w: WireCtx, c: Compute) {
  const q = c.needsHuman
  if (!q?.qid) return w.get().toast('这件已经不在等你了，这次交还不再送给它')
  const r = await w.call('tasks.answer', { taskId: c.id, qId: q.qid, clientActionId: actionId(), answer: `「${q.what}」我已经处理好了，交还给你接着做` })
  if (!r.ok) return fail(w, '交还', r.error.message)
  refresh(w, r.value)
}

/** 不做了:提问卡上的「不做了」——任务取消、Compute 停下 */
export async function declineHumanLive(w: WireCtx, c: Compute) {
  const hit = findCard(w.get().convs, (k) => k.kind === 'question' && k.taskId === c.id && k.state === 'open' && k.actions.some((a) => a.id === 'reject'))
  if (!hit) return w.get().toast('这件已经不在等你了')
  return act(w, hit.msg.card.id, (ids) => ids.find((x) => x === 'reject'), { what: '取消这件' })
}
