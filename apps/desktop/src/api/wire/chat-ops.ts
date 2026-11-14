// 消息操作接线(连上后端时):撤回、编辑、表情、私聊回退、删除 / 清空(只在你这边)、转发、置顶、改挂补充、发附件。
// 每个动作调合同方法,以后端回包和事件为准写回界面;失败就说清原因、界面不变。没连后端时这些都不走这里(切片里照旧演示)。
import type { RewindPreview, TaskView } from '@g-group/api-contract'
import type { MsgFile } from '@/data'
import { notify } from '@/hooks/use-toast'
import { appShell } from '../app-shell'
import { loadMessages, msgId, putMessages, recalledText, sendLive, seqOf } from './messages'
import { upsertRoom } from './rooms'
import { actionId, defineWiring, read, type WireCtx } from './types'

/** 消息 id → 所在会话与序号;本地还没回包的、演示消息都没有 */
export function locate(w: WireCtx, id: string): { roomId: string; seq: number } | null {
  const seq = seqOf(id)
  const conv = w.get().convs.find((c) => c.messages.some((m) => 'id' in m && m.id === id))
  return seq === null || !conv ? null : { roomId: conv.id, seq }
}
const fail = (w: WireCtx, what: string, e: { message: string }) => w.get().toast(`${what}：${e.message}`)
const notYet = (w: WireCtx) => w.get().toast('这条还没发出去，等它发出去再操作')

/** 撤回自己的消息:后端只给「撤回了一条」,原文留在这台机器上给「重新编辑」用 */
export async function recallLive(w: WireCtx, id: string) {
  const at = locate(w, id)
  if (!at) return notYet(w)
  const m = w.get().convs.find((c) => c.id === at.roomId)?.messages.find((x) => 'id' in x && x.id === id)
  if (m?.k === 'text') recalledText.set(id, m.text)
  const r = await w.call('messages.retract', at)
  if (!r.ok) { recalledText.delete(id); return fail(w, '没撤回', r.error) }
  putMessages(w, at.roomId, [r.value])
}

/** 编辑自己的消息:以回包为准标「已编辑」;在途任务原位升版由宿主做,界面跟着事件显示 */
export async function editLive(w: WireCtx, id: string, text: string): Promise<boolean> {
  const at = locate(w, id)
  if (!at) { notYet(w); return false }
  const r = await w.call('messages.edit', { ...at, text })
  if (!r.ok) { fail(w, '没改成', r.error); return false }
  putMessages(w, at.roomId, [r.value])
  return true
}

/** 表情:你点过就取消,没点过就加上;以回包里的回应为准 */
export async function reactLive(w: WireCtx, id: string, emoji: string) {
  const at = locate(w, id)
  if (!at) return notYet(w)
  const on = !(w.get().reactions[id]?.[emoji] ?? []).includes('me')
  const r = await w.call('messages.react', { ...at, emoji, on })
  if (!r.ok) return fail(w, '表情没加上', r.error)
  putMessages(w, at.roomId, [r.value])
}

/** 私聊回退预览:只读,算出会撤下几条、取消哪些在途任务、作废几条承诺、哪些已发生的事撤不回 */
export async function rewindPreviewLive(w: WireCtx, roomId: string, id: string): Promise<RewindPreview | string> {
  const seq = seqOf(id)
  if (seq === null) return '这条还没发出去'
  const r = await w.call('rooms.rewindPreview', { roomId, toSeq: seq })
  return r.ok ? r.value : r.error.message
}

/** 私聊回退:撤下的消息、回退说明由事件带回;这里只把回包里的撤下与说明先写上 */
export async function rewindLive(w: WireCtx, roomId: string, id: string) {
  const seq = seqOf(id)
  if (seq === null) return notYet(w)
  const r = await w.call('rooms.rewind', { roomId, toSeq: seq, clientActionId: actionId() })
  if (!r.ok) return fail(w, '没退回去', r.error)
  await loadMessages(w, roomId).catch(() => {})
}

/** 删除(只在你这边):删完提示条上可以撤销,撤销 = 放回来再读一遍 */
export async function hideLive(w: WireCtx, ids: readonly string[]) {
  const byRoom = new Map<string, number[]>()
  for (const id of ids) {
    const at = locate(w, id)
    if (at && !id.endsWith('~c')) byRoom.set(at.roomId, [...(byRoom.get(at.roomId) ?? []), at.seq])
  }
  if (!byRoom.size) return notYet(w)
  let n = 0
  for (const [roomId, seqs] of byRoom) {
    const r = await w.call('messages.hide', { roomId, seqs })
    if (!r.ok) return fail(w, '没删掉', r.error)
    n += seqs.length
    const gone = new Set(seqs.flatMap((s) => [msgId(roomId, s), `${msgId(roomId, s)}~c`]))
    w.get().setConvs((cs) => cs.map((c) => (c.id === roomId ? { ...c, messages: c.messages.filter((m) => !('id' in m) || !gone.has(m.id)) } : c)))
  }
  const undo = async () => {
    for (const [roomId, seqs] of byRoom) {
      const r = await w.call('messages.hide', { roomId, seqs, hidden: false })
      if (!r.ok) return fail(w, '没放回来', r.error)
      await loadMessages(w, roomId).catch(() => {})
    }
  }
  notify(n > 1 ? `已删除 ${n} 条，只在你这边看不到；别人那边还在` : '已删除，只在你这边看不到；别人那边还在', { action: { label: '撤销', onClick: () => void undo() } })
}

/** 清空聊天记录(只在你这边) */
export async function clearLive(w: WireCtx, roomId: string): Promise<boolean> {
  const r = await w.call('rooms.clearHistory', { roomId })
  if (!r.ok) { fail(w, '没清空', r.error); return false }
  w.get().setConvs((cs) => cs.map((c) => (c.id === roomId ? { ...c, messages: [] } : c)))
  w.get().toast('已清空，只影响你自己看到的；助手的记忆和资产不受影响')
  return true
}

/** 转发选中的几条:收件会话里出现一张转发卡,切过去 */
export async function forwardLive(w: WireCtx, from: string, ids: readonly string[], to: string) {
  const seqs = ids.flatMap((id) => (id.endsWith('~c') ? [] : [seqOf(id)])).filter((s): s is number => s !== null)
  if (!seqs.length) return notYet(w)
  const r = await w.call('messages.forward', { clientActionId: actionId(), fromRoomId: from, seqs: [...new Set(seqs)], toRoomId: to })
  if (!r.ok) return fail(w, '没转发出去', r.error)
  putMessages(w, to, [r.value])
  w.get().openConv(to)
}

/** 置顶 / 取消置顶:以回包的会话为准(置顶条、置顶消息页都读它) */
export async function pinLive(w: WireCtx, roomId: string, id: string) {
  const seq = seqOf(id)
  if (seq === null) return notYet(w)
  const on = !(w.get().convs.find((c) => c.id === roomId)?.pins ?? []).includes(id)
  const r = await w.call('messages.pin', { roomId, seq, on })
  if (!r.ok) return fail(w, on ? '没置顶' : '没移出置顶', r.error)
  upsertRoom(w, r.value)
  w.get().toast(on ? '已设为置顶消息' : '已移出置顶消息')
}

/** 改挂一条补充(AC-15):从它现在挂着的那件移到另一件;源任务不取消、版本 +1 */
export async function retagLive(w: WireCtx, id: string, toTaskId: string) {
  const at = locate(w, id)
  if (!at) return notYet(w)
  const from = followUpOwner(at.roomId, at.seq)
  if (!from) return w.get().toast('这条现在没挂在任何一件事上')
  const r = await w.call('tasks.rebindFollowUp', { ...at, fromTaskId: from.id, toTaskId, expectedBindingVersion: from.bindingVersion ?? 0, clientActionId: actionId() })
  if (!r.ok) return fail(w, '没改挂', r.error)
  noteTasks(w, [r.value.from, r.value.to])
}

/** 发附件:磁盘文件交给宿主读取;截图/内存文件按内容上传,再作为一条消息发出。 */
export async function attachLive(w: WireCtx, roomId: string, files: readonly File[]) {
  const done: MsgFile[] = []
  for (const f of files) {
    try {
      const localPath = appShell?.getPathForFile(f)
      const r = localPath
        ? await w.call('attachments.add', { path: localPath })
        : await w.call('attachments.upload', { name: f.name, base64: await toBase64(f) })
      if (!r.ok) return fail(w, `「${f.name}」没发出去`, r.error)
      done.push(r.value)
    } catch (e) {
      return w.get().toast(`「${f.name}」没发出去：${e instanceof Error ? e.message : String(e)}`)
    }
  }
  if (done.length) await sendLive(w, roomId, '', [], done)
}
async function toBase64(f: File): Promise<string> {
  const bytes = new Uint8Array(await f.arrayBuffer())
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

/** 从群聊私信那里说话 = 在群里 @它(U46),走同一条发送路径 */
export const sendAsLive = (w: WireCtx, roomId: string, text: string) => sendLive(w, roomId, text, [])

// ---- 补充挂在哪件事上(AC-15/40⑨):按任务的 followUps 给你的消息标「归到「…」· 已收到」 ----
/** 每件任务最近一次的视图(改挂要带它的 bindingVersion) */
const taskViews = new Map<string, TaskView>()
const FOLLOW_STATE: Record<string, string> = { Received: '已收到', Applied: '已落实' }

function followUpOwner(roomId: string, seq: number): TaskView | undefined {
  return [...taskViews.values()].find((t) => t.followUps?.some((f) => f.roomId === roomId && f.seq === seq && f.state !== 'Rebound'))
}

/** 记下任务视图,并把它的补充标到对应消息上(改挂走的那条由它新挂的那件来标) */
export function noteTasks(w: WireCtx, tasks: readonly TaskView[]) {
  const tags = new Map<string, { task: string; state: string } | null>()
  for (const t of tasks) {
    taskViews.set(t.id, t)
    for (const f of t.followUps ?? []) {
      const id = msgId(f.roomId, f.seq)
      if (f.state === 'Rebound') { if (!tags.has(id)) tags.set(id, null) } else tags.set(id, { task: t.id, state: FOLLOW_STATE[f.state] ?? f.state })
    }
  }
  if (!tags.size) return
  w.get().setConvs((cs) => cs.map((c) => (c.messages.some((m) => 'id' in m && tags.has(m.id))
    ? { ...c, messages: c.messages.map((m) => {
        if (m.k !== 'text' || !tags.has(m.id)) return m
        const tag = tags.get(m.id)
        if (tag) return { ...m, tag }
        const rest = { ...m }
        delete rest.tag
        return rest
      }) }
    : c)))
}

/** 这件事的负责人还能接改挂过来的补充吗(还没收口的才行) */
export const liveTaskOpen = (id: string) => {
  const t = taskViews.get(id)
  return !!t && !['T8_Accepted', 'T10_Cancelled', 'T11_Failed'].includes(t.state)
}
export const taskRoom = (id: string) => taskViews.get(id)?.roomId


/** 补充挂在哪件事上:读全部任务、跟 task.updated,把补充标到消息上(排在任务接线之后,消息已读进来) */
export const followUpsWiring = defineWiring({
  entity: '补充归属',
  load: async (w) => {
    const { tasks } = await read(w, 'tasks.list', { limit: 500 })
    noteTasks(w, tasks)
  },
  on: {
    'task.updated': (ev, w) => noteTasks(w, [ev.task]),
  },
})
