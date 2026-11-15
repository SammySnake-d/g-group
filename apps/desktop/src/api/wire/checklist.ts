// 群清单接线(U14 / AC-47 / AC-50):本群的任务就是群清单。tasks.list 全量读 → 清单;task.updated 整条换。
// 业务状态由任务状态机说了算,不另存:没人负责 = 待认领;联系人认领后在做 = 进行中;交付等你确认 = 待验收;你验收了 = 已完成;
// 取消的不再列。新建(tasks.create)和交给联系人(tasks.assign)都以一条你的对话消息记进群里,由联系人认领并起 Compute。
import type { TaskStateName, TaskView } from '@g-group/api-contract'
import type { ListItem, PersonId, TaskStatus } from '@/data'
import { actionId, defineWiring, read, type WireCtx } from './types'

const STATUS: Record<TaskStateName, TaskStatus | null> = {
  T1_Open: '待认领', T2_Claimed: '进行中', T3_Running: '进行中', T4b_BlockedOnHuman: '进行中', T9_StopRequested: '进行中', T11_Failed: '进行中',
  T5_InReview: '待验收', T7_Delivering: '待验收', T8a_Delivered: '待验收', T8_Accepted: '已完成', T10_Cancelled: null,
}

/** 合同的任务 → 清单的一项;取消的任务返回 null */
export function toListItem(t: TaskView): ListItem | null {
  const status = t.state === 'T1_Open' && t.ownerContactId ? '进行中' : STATUS[t.state]
  if (!status) return null
  return {
    id: t.id, conv: t.roomId, text: t.title, status,
    ...(t.description ? { desc: t.description } : {}),
    ...(t.ownerContactId ? { who: t.ownerContactId } : {}),
    /* 在界面上一件任务的 Compute 就用任务 id(见 api/wire/tasks) */
    attempts: t.ownerContactId ? [t.id] : [],
  }
}

/** 每件任务见过的最新版本(stateVer):旧版本晚到不覆盖 */
const seen = new Map<string, number>()
const fresh = (t: TaskView) => {
  const v = t.stateVer ?? 0
  if (v < (seen.get(t.id) ?? 0)) return false
  seen.set(t.id, v)
  return true
}

export const checklistWiring = defineWiring({
  entity: '群清单',
  load: async (w) => {
    const { tasks } = await read(w, 'tasks.list', { limit: 500 })
    const groups = new Set(w.get().convs.filter((c) => c.kind === 'group').map((c) => c.id))
    w.get().setChecklist(tasks.flatMap((t) => { fresh(t); return groups.has(t.roomId) ? (toListItem(t) ?? []) : [] }))
  },
  on: {
    'task.updated': (ev, w) => {
      if (!fresh(ev.task)) return
      if (w.get().convs.find((c) => c.id === ev.task.roomId)?.kind !== 'group') return
      const it = toListItem(ev.task)
      if (it) w.get().putListItem(it)
      else w.get().dropListItem(ev.task.id)
    },
  },
})

const why = (e: { message: string }) => e.message

/** 新建一项:标题、描述分开;指了人就由它认领并起 Compute,没指就待认领 */
export async function createTaskLive(w: WireCtx, t: { conv: string; text: string; desc?: string; who?: PersonId }) {
  const r = await w.call('tasks.create', { clientActionId: actionId(), roomId: t.conv, title: t.text, ...(t.desc ? { description: t.desc } : {}), ...(t.who ? { ownerContactId: t.who } : {}) })
  if (!r.ok) { w.get().toast(`没建成：${why(r.error)}`); return }
  if (fresh(r.value)) { const it = toListItem(r.value); if (it) w.get().putListItem(it) }
}

/** 一次加几项(Helper 把 CSV 转成清单时逐行调用),都待认领 */
export async function createTasksLive(w: WireCtx, conv: string, texts: string[]) {
  for (const text of texts) await createTaskLive(w, { conv, text })
}

/** 交给某位联系人:以你的一条消息 @ 它,由它认领并起 Compute */
export async function assignTaskLive(w: WireCtx, taskId: string, who: PersonId) {
  const r = await w.call('tasks.assign', { taskId, contactId: who, clientActionId: actionId() })
  if (!r.ok) { w.get().toast(`没交出去：${why(r.error)}`); return }
  if (fresh(r.value)) { const it = toListItem(r.value); if (it) w.get().putListItem(it) }
}

/** 清单状态跟着任务走:你能做的只有验收(待验收 → 已完成),别的状态由联系人和 Compute 推进 */
export async function setTaskStatusLive(w: WireCtx, taskId: string, st: TaskStatus) {
  if (st !== '已完成') { w.get().toast('清单状态跟着任务走：认领、开工、交付由联系人推进，你在这里能做的是验收'); return }
  const r = await w.call('tasks.accept', { taskId, clientActionId: actionId() })
  if (!r.ok) { w.get().toast(`没验收成：${why(r.error)}`); return }
  if (fresh(r.value)) { const it = toListItem(r.value); if (it) w.get().putListItem(it) }
}
