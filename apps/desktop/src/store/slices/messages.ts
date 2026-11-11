// 消息操作切片:撤回、编辑、私聊回退、删除、转发、置顶、投票、改挂、群公告。
import { people, type Msg, type Pending, type PersonId } from '@/data'
import { notify } from '@/hooks/use-toast'
import { live, liveCtx } from '@/api/wire/live'
import { addNoticeLive, editNoticeLive } from '@/api/wire/notices'
import { broken } from '@/mut'
import { uid } from '../boot'
import { lens, type Slice } from '../state'
import { activeConv } from '../select'

type TextMsg = Extract<Msg, { k: 'text' }>

/** 这一片经 useApp() 对外暴露的字段(Ctx 的一部分)。加字段:写在这里,再把名字加进下面的 MESSAGES_CTX_KEYS */
export interface MessagesCtx {
  recall: (msgId: string) => void
  /** C-US08：编辑自己发过的消息 → 标已编辑；在回它的助手作废旧草稿、按新内容重写 */
  editMsg: (msgId: string, text: string) => void
  rewindAsk: string | null
  setRewindAsk: (msgId: string | null) => void
  /** AC-48：私聊回到某条消息。之后的消息撤下、由它们派生的待你回答作废；可恢复 */
  rewind: (convId: string, msgId: string) => void
  unrewind: (sysId: string) => void
  deleteMsgs: (ids: string[]) => void
  deleteMsg: (msgId: string) => void
  forward: (from: string, msgIds: string[], to: string) => void
  pinMsg: (convId: string, msgId: string) => void
  decideVote: (msgId: string, opt: number) => void
  retag: (msgId: string, task: string | null) => void
  clearHistory: (convId: string) => void
  setNotice: (convId: string, text: string) => void
  /** 改某一条公告：版本号 +1，助手下次接活 / 醒来装配新版本（U86） */
  editNotice: (convId: string, noticeId: string, text: string) => void
}
export const MESSAGES_CTX_KEYS = ['recall', 'editMsg', 'rewindAsk', 'setRewindAsk', 'rewind', 'unrewind', 'deleteMsgs', 'deleteMsg', 'forward', 'pinMsg', 'decideVote', 'retag', 'clearHistory', 'setNotice', 'editNotice'] as const satisfies readonly (keyof MessagesCtx)[]

export type MessagesSlice = MessagesCtx

export const createMessagesSlice: Slice<MessagesSlice> = (set, get) => {
  const L = lens(set)
  const sys = (cid: string, text: string) => get().pushMsg({ k: 'sys', id: 's' + uid(), text }, cid)
  const mapMsgs = (f: (m: Msg) => Msg) => L.convs((cs) => cs.map((c) => ({ ...c, messages: c.messages.map(f) })))
  /** 私聊回退时撤下的消息(可恢复),按回退那行系统消息的 id 存 */
  const rewound: Record<string, { conv: string; msgs: Msg[]; pending: Pending[] }> = {}
  const nowStep = (cid: string) => Math.max(0, get().computes[cid].steps.findIndex((s) => s.state === 'now'))
  /* 删除只在你这边隐藏;提示条上可以撤销(Vercel:破坏性操作要可撤销)。每条记住它前面那条的 id,撤销时插回原位 */
  const hide = (ids: string[], text: string) => {
    const gone: { cid: string; after: string | null; m: Msg }[] = []
    for (const c of get().convs) {
      let prev: string | null = null
      for (const m of c.messages) {
        if (!('id' in m)) continue
        if (ids.includes(m.id)) gone.push({ cid: c.id, after: prev, m })
        prev = m.id
      }
    }
    L.convs((cs) => cs.map((c) => ({ ...c, messages: c.messages.filter((m) => !('id' in m) || !ids.includes(m.id)) })))
    const undo = () => L.convs((cs) => cs.map((c) => {
      const mine = gone.filter((g) => g.cid === c.id)
      if (!mine.length) return c
      const msgs = [...c.messages]
      for (const g of mine) msgs.splice(g.after ? msgs.findIndex((m) => 'id' in m && m.id === g.after) + 1 : 0, 0, g.m)
      return { ...c, messages: msgs }
    }))
    notify(text, { action: { label: '撤销', onClick: undo } })
  }

  return {
    rewindAsk: null,
    setRewindAsk: (rewindAsk) => set({ rewindAsk }),

    /* AC-08:撤回级联。由这条消息派生的承诺停掉、还没回答的选项作废;已经做了的事撤不回,只在撤回提示里写明。
       撤回后搜索不再返回原文(消息变成系统行,原文只留给你自己「重新编辑」) */
    recall: (mid) => {
      const { commits, computes } = get()
      const conv = activeConv(get())
      const derived = broken('AC-08') ? [] : commits.filter((c) => c.srcMsg === mid && c.on)
      const doneBy = broken('AC-08') ? [] : Object.values(computes).filter((c) => c.askMsg === mid && c.status === 'done')
      const runBy = broken('AC-08') ? [] : Object.values(computes).filter((c) => c.askMsg === mid && c.status === 'running')
      if (derived.length) L.commits((l) => l.map((c) => (c.srcMsg === mid ? { ...c, on: false } : c)))
      if (!broken('AC-08')) L.pending((ps) => ps.map((p) => (p.kind === 'choice' && !p.stale && conv.messages.some((m) => m.k === 'text' && m.id === p.ask && m.quotes?.some((x) => x.msgId === mid)) ? { ...p, stale: mid } : p)))
      const tail = [derived.length ? `${derived.length} 条由它记下的承诺已停` : '', runBy.length ? `「${runBy.map((c) => c.short ?? c.title).join('」「')}」还在做，要停请在它那里按停止` : '', doneBy.length ? `「${doneBy.map((c) => c.title).join('」「')}」已经做了，撤不回` : ''].filter(Boolean).join('；')
      mapMsgs((m) => {
        if (m.k === 'text' && m.id === mid) return { k: 'sys', id: m.id, text: '你撤回了一条消息' + (tail ? '：' + tail : ''), recalled: m.text } as Msg
        /* D21 归属表 15 / AC-08:被总结的消息撤回了,摘要不能比原文活得久 → 标已过期,可重做 */
        if (m.k === 'summary' && !broken('AC-08-sum') && (m.covers ?? m.items.map((x) => x.ref).filter(Boolean) as string[]).includes(mid)) return { ...m, expired: mid }
        return m
      })
    },

    editMsg: (mid, text) => {
      const t = text.trim(); if (!t) return
      const { computes } = get()
      mapMsgs((m) => {
        if (m.k === 'text' && m.id === mid) return { ...m, text: t, edited: true }
        if (broken('AC-45-fork') && m.k === 'compute' && computes[m.computeId]?.askMsg === mid) return m
        if (!broken('C-US08') && m.k === 'replying' && m.quotes.some((q) => q.msgId === mid))
          return { ...m, quotes: m.quotes.map((q) => (q.msgId === mid ? { ...q, text: t } : q)), phase: '原消息改了，旧草稿作废，按新内容重写', mins: 0, steps: ['旧草稿作废', '按改后的内容重新读'] }
        return m
      })
      /* AC-45②:在途任务原位升版 v1 → v2,新条件送进同一个 Compute,不新开任务 */
      const live = Object.values(computes).find((c) => c.askMsg === mid && c.status === 'running')
      if (live) {
        if (broken('AC-45-fork')) {
          const nid = live.id + '-v2'
          L.computes((cs) => ({ ...cs, [nid]: { ...live, id: nid, title: live.title + '（新条件）', activity: [], cver: 2, constraint: t } }))
          get().pushMsg({ k: 'compute', id: 'cm' + uid(), from: live.owner, computeId: nid }, live.conv)
        } else {
          const v = (live.cver ?? 1) + 1
          L.computes((cs) => ({ ...cs, [live.id]: { ...cs[live.id], cver: v, constraint: t, phase: `按改后的要求继续（v${v}）` } }))
          get().addAct(live.id, { step: Math.max(0, live.steps.findIndex((x) => x.state === 'now')), kind: 'user', title: `你改了要求（v${v}）：${t}。在这件里接着做，不另开` })
          get().say(live.conv, live.owner, `收到改后的要求，在「${live.short ?? live.title}」里接着做，不另开一件。`, 500)
        }
      }
      set({ editing: null })
      get().setDraft('')
    },

    /* AC-48:私聊 rewind。回到某条消息:之后的消息撤下(暂存,可恢复),由它们派生的待你回答一起作废,
       承诺停掉;已经做完的事撤不回,写在提示里。和 Compute 的检查点回滚不是一回事:这里退的是聊天 */
    rewind: (cid, mid) => {
      const { convs, pending, commits, computes } = get()
      const c = convs.find((x) => x.id === cid); if (!c) return
      const at = c.messages.findIndex((m) => 'id' in m && m.id === mid); if (at < 0) return
      const after = c.messages.slice(at + 1)
      const ids = new Set(after.flatMap((m) => ('id' in m ? [m.id] : [])))
      const n = after.filter((m) => m.k !== 'date').length
      if (!n) { get().toast('这已经是最后一条了'); return }
      const gone = broken('AC-48-2') ? [] : pending.filter((p) => p.conv === cid && 'ask' in p && !!p.ask && ids.has(p.ask))
      const derived = commits.filter((x) => x.srcMsg && ids.has(x.srcMsg) && x.on)
      const done = Object.values(computes).filter((x) => x.askMsg && ids.has(x.askMsg) && x.status === 'done')
      if (gone.length) L.pending((ps) => ps.filter((p) => !gone.includes(p)))
      if (derived.length) L.commits((l) => l.map((x) => (x.srcMsg && ids.has(x.srcMsg) ? { ...x, on: false } : x)))
      const sid = 'rw' + uid()
      rewound[sid] = { conv: cid, msgs: after, pending: gone }
      const head = c.messages[at] as TextMsg
      const what = head.k === 'text' ? `「${head.text.replace(/^@\S+\s/, '').slice(0, 14)}${head.text.length > 14 ? '…' : ''}」` : '这一条'
      const tail = [gone.length ? `${gone.length} 个等你回答的问题一起作废` : '', derived.length ? `${derived.length} 条承诺已停` : '', done.length ? `「${done.map((x) => x.title).join('」「')}」已经做了，撤不回` : ''].filter(Boolean).join('；')
      const line: Msg = { k: 'sys', id: sid, text: `你把聊天退回到${what}，之后 ${n} 条已撤下，${people[c.members.find((m) => m !== 'me') as PersonId]?.name ?? '对方'} 从这里接着聊${tail ? '；' + tail : ''}`, rewind: true }
      L.convs((cs) => cs.map((x) => (x.id === cid ? { ...x, messages: broken('AC-48-1') ? [...x.messages, line] : [...x.messages.slice(0, at + 1), line] } : x)))
      set({ rewindAsk: null })
    },
    unrewind: (sid) => {
      const r = rewound[sid]; if (!r) return
      delete rewound[sid]
      L.convs((cs) => cs.map((x) => {
        if (x.id !== r.conv) return x
        const i = x.messages.findIndex((m) => 'id' in m && m.id === sid)
        if (broken('AC-48-3')) return { ...x, messages: x.messages.filter((m) => !('id' in m) || m.id !== sid) }
        return { ...x, messages: [...x.messages.slice(0, i), ...r.msgs, ...x.messages.slice(i + 1)] }
      }))
      if (r.pending.length && !broken('AC-48-3')) L.pending((ps) => [...ps, ...r.pending])
      get().toast('已恢复撤下的消息')
    },

    deleteMsgs: (ids) => hide(ids, `已删除 ${ids.length} 条，只在你这边看不到；别人那边还在`),
    deleteMsg: (mid) => hide([mid], '已删除，只在你这边看不到；别人那边还在'),
    clearHistory: (cid) => {
      L.convs((cs) => cs.map((c) => (c.id === cid ? { ...c, messages: [{ k: 'sys', id: 's' + uid(), text: '你清空了这里的聊天记录（只影响你自己看到的；助手的记忆和资产不受影响）' }] } : c)))
      set({ stack: [] })
    },

    forward: (from, ids, to) => {
      const { convs, pending } = get()
      const src = convs.find((c) => c.id === from)!
      const items = src.messages.filter((m) => 'id' in m && ids.includes(m.id) && m.k === 'text').map((m) => ({ from: (m as TextMsg).from, text: (m as TextMsg).text }))
      get().pushMsg({ k: 'forward', id: 'f' + uid(), from: 'me', srcTitle: src.title, items }, to)
      /* AC-20 / R-10:转发进来的「同意」不是你本人的授权。目标会话有等你同意的写盘,就照旧等,并说清楚为什么 */
      const gate = pending.find((p) => p.kind === 'proposal' && p.gate && p.conv === to)
      if (gate && items.some((x) => /同意|可以改|改吧|批准/.test(x.text))) {
        if (broken('AC-20')) get().resolve(gate.id, 'ok')
        else get().say(to, gate.from, '转发里的“同意”不算你本人的授权，我还在等你自己点「同意，改吧」或者直接说一句。', 800)
      }
      get().setSelecting(false)
      set({ section: 'chat', active: to })
    },

    pinMsg: (cid, mid) => {
      const c = get().convs.find((x) => x.id === cid)!
      const on = !(c.pins ?? []).includes(mid)
      L.convs((cs) => cs.map((x) => (x.id === cid ? { ...x, pins: on ? [...(x.pins ?? []), mid] : (x.pins ?? []).filter((p) => p !== mid) } : x)))
      get().toast(on ? '已设为置顶消息' : '已移出置顶消息')
    },
    decideVote: (mid, opt) => {
      mapMsgs((m) => (m.k === 'vote' && m.id === mid ? { ...m, decided: opt } : m))
      const owner = get().convs.find((c) => c.messages.some((m) => 'id' in m && m.id === mid))!
      const v = owner.messages.find((m) => m.k === 'vote' && m.id === mid) as Extract<Msg, { k: 'vote' }>
      get().pushMsg({ k: 'text', id: 'me-' + uid(), from: 'me', text: `就用「${v.options[opt]}」`, quotes: [{ msgId: mid, from: v.from, text: v.title, reply: true }] }, owner.id)
      get().say(owner.id, v.from, '好，按这个定。已写进群协作手册。', 700)
    },
    retag: (msgId, task) => {
      mapMsgs((m) => (m.k === 'text' && m.id === msgId ? { ...m, tag: task ? { task, state: '已改挂' } : { task: '', state: '' } } : m))
      if (task) get().addAct(task, { step: nowStep(task), kind: 'user', title: '你把一条补充改挂到这件事上' })
    },

    setNotice: (cid, text) => {
      if (live(get())) { void addNoticeLive(liveCtx(get, set), cid, text); return }
      L.convs((cs) => cs.map((c) => (c.id === cid ? { ...c, notice: text, noticeBy: '你 · 刚刚', notices: [{ id: 'n' + uid(), text, by: '你', at: '刚刚', ver: 1 }, ...(c.notices ?? [])] } : c)))
      sys(cid, text ? `你更新了群公告：${text.split('\n')[0]}` : '你清空了群公告')
    },
    editNotice: (cid, nid, text) => {
      const n = get().convs.find((c) => c.id === cid)?.notices?.find((x) => x.id === nid)
      if (live(get())) { if (n) void editNoticeLive(liveCtx(get, set), cid, nid, text, n.ver); return }
      L.convs((cs) => cs.map((c) => (c.id === cid ? { ...c, notices: (c.notices ?? []).map((x) => (x.id === nid ? { ...x, text, ver: x.ver + 1, by: '你', at: '刚刚' } : x)) } : c)))
      sys(cid, `你把群公告改到 v${(n?.ver ?? 0) + 1}：${text.split('\n')[0]}`)
    },
  }
}
