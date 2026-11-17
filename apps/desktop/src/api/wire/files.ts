// 文件接线(AC-57 文件列表与窗口联动):每个会话 files.list(附件 + 任务产出)→ 文件区;
// 交付消息带回的工件快照(AC-04,消息上的 artifacts)也列进来,点开用 artifacts.get 读。
// 来处 = 出现它的那条消息(附件 = 带它的消息;任务产出 = 交付消息,没有交付时为派活消息),文件区正文右侧据此画来往、点了跳回原消息。
// 有新附件、新交付(任务带上交付消息序号)时重读一遍。
import type { FileEntry } from '@g-group/api-contract'
import type { Artifact, PersonId } from '@/data'
import { msgId } from './messages'
import { clockOf, defineWiring, read, type WireCtx } from './types'

const KB = 1024
export const sizeOf = (n: number) => (n < KB ? `${n} B` : n < KB * KB ? `${Math.round(n / KB)} KB` : `${(n / KB / KB).toFixed(1)} MB`)
const kindOf = (mime: string) => (mime.startsWith('image/') ? '图片' : mime.startsWith('text/') || mime === 'application/json' ? '文本' : mime === 'application/pdf' ? 'PDF' : '文件')

/** 那条消息是谁发的;读不到就看任务负责人,再不行算你的 */
function senderAt(w: WireCtx, roomId: string, seq: number, taskId: string | null): PersonId {
  const m = w.get().convs.find((c) => c.id === roomId)?.messages.find((x) => 'id' in x && x.id === msgId(roomId, seq))
  if (m && 'from' in m) return m.from
  return (taskId && w.get().computes[taskId]?.owner) || 'me'
}

function fromEntry(w: WireCtx, roomId: string, f: FileEntry): Artifact {
  return {
    id: f.ref, name: f.name, kind: 'doc', meta: `${kindOf(f.mime)} · ${sizeOf(f.bytes)}`, by: senderAt(w, roomId, f.seq, f.taskId), conv: roomId, when: clockOf(f.at),
    live: { ref: f.ref, src: msgId(roomId, f.seq), mime: f.mime, bytes: f.bytes, via: 'file' },
  }
}

/** 读全部会话的文件;某个会话读不到不拦别的,读完再说哪几个没读到 */
export async function loadFiles(w: WireCtx) {
  const convs = w.get().convs
  const res = await Promise.allSettled(convs.map(async (c) => ({ roomId: c.id, files: (await read(w, 'files.list', { roomId: c.id })).files })))
  const list: Artifact[] = []
  for (const r of res) if (r.status === 'fulfilled') for (const f of r.value.files) list.push(fromEntry(w, r.value.roomId, f))
  const seen = new Set(list.map((a) => a.id))
  for (const c of w.get().convs) {
    for (const m of c.messages) {
      if (m.k !== 'text' || !m.deliverables) continue
      for (const d of m.deliverables) {
        if (seen.has(d.ref)) continue
        seen.add(d.ref)
        list.push({ id: d.ref, name: d.name, kind: 'doc', meta: `${kindOf(d.mime)} · ${sizeOf(d.bytes)}`, by: m.from, conv: c.id, when: m.at ?? '', live: { ref: d.ref, src: m.id, mime: d.mime, bytes: d.bytes, via: 'artifact' } })
      }
    }
  }
  w.get().setLiveFiles(list)
  const bad = res.filter((r) => r.status === 'rejected').length
  if (bad) throw new Error(`${bad} 个会话的文件没读到`)
}

/** 事件密的时候合并成一次重读 */
let timer: ReturnType<typeof setTimeout> | null = null
const later = (w: WireCtx) => {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => { timer = null; void loadFiles(w).catch((e) => console.error('[wire] 文件重读失败', e)) }, 200)
}

export const filesWiring = defineWiring({
  entity: '文件',
  load: loadFiles,
  on: {
    'message.appended': (ev, w) => { if (ev.message.attachments.length || ev.message.artifacts?.length) later(w) },
    'task.updated': (ev, w) => { if (ev.task.deliveredSeq != null) later(w) },
  },
})
