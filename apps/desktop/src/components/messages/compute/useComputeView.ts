/* Compute 在聊天里那一行要显示的状态(纯计算,界面在 ComputeLine) */
import { useApp } from '@/ctx'
import { broken } from '@/mut'
import { receiptOf } from '@/components/Receipt'

export type ComputeView = 'stalled' | 'human' | 'error' | 'done' | 'plain'

export function useComputeView(id: string) {
  const { computes, pending, convs } = useApp()
  let c = computes[id]
  if (!c) return null
  /* 坏实现(埋雷 AC-46-4):派活那条消息全读了,就把任务当成做完。AC-46⑥:已读不等于已落实,做完没有只看任务本身 */
  if (broken('AC-46-4') && c.askMsg && c.status === 'running') {
    const cv = convs.find((x) => x.id === c.conv); const am = cv?.messages.find((x) => 'id' in x && x.id === c.askMsg) as { text?: string } | undefined
    const rc = cv && receiptOf(cv, c.askMsg, 'me', am?.text ?? '')
    if (rc && rc.read.length && !rc.unread.length) c = { ...c, status: 'done', result: '已完成' }
  }
  /** 出错时挂着的那条待你处理(重试 / 换个模型 / 跳过都落在它上面) */
  const err = pending.find((p) => p.kind === 'error' && p.computeId === id)
  /* AC-14 停滞:在跑但超过 10 分钟没动静;C-US15:卡在只有人能过的一步;
     AC-36:连上后端时任务在等你选(失败卡还开着)那件仍算在跑,这一行照样原地变红给出几条路 */
  const view: ComputeView = !broken('AC-14') && c.status === 'running' && (c.idleMin ?? 0) >= 10 ? 'stalled'
    : c.status === 'running' && c.needsHuman ? 'human'
    : c.status === 'error' || (c.status === 'running' && err) ? 'error'
    : c.status === 'done' ? 'done'
    : 'plain'
  return {
    c,
    view,
    stepsDone: c.steps.filter((s) => s.state === 'done').length,
    err,
  }
}
