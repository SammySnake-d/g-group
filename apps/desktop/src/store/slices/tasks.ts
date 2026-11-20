import { people, type Board, type Commitment, type ListItem, type PersonId, type PlaybookItem } from '@/data'
import { assignTaskLive, createTaskLive, createTasksLive, setTaskStatusLive } from '@/api/wire/checklist'
import { live, liveCtx } from '@/api/wire/live'
import { broken } from '@/mut'
import { later, uid } from '../boot'
import { HELPER_CARDS, IMPORTED_BOARD, SUMMARY_DEMO } from '../demo'
import { lens, type Slice } from '../state'

export interface TasksCtx {
  boards: Record<string, Board>
  commits: Commitment[]
  playbook: PlaybookItem[]
  checklist: ListItem[]
  claim: (boardId: string, row: number, who: PersonId) => void
  importBoard: (convId: string, rows?: string[]) => void
  claimTask: (taskId: string, who: PersonId) => void
  setTaskStatus: (taskId: string, st: ListItem['status']) => void
  addTasks: (convId: string, texts: string[]) => void
  addTask: (t: { text: string; desc?: string; who?: PersonId; conv: string }) => string
  summarize: (convId: string) => void
  helperReply: (convId: string, ask: string) => void
}
export const TASKS_CTX_KEYS = ['boards', 'commits', 'playbook', 'checklist', 'claim', 'importBoard', 'claimTask', 'setTaskStatus', 'addTasks', 'addTask', 'summarize', 'helperReply'] as const satisfies readonly (keyof TasksCtx)[]

export type TasksSlice = TasksCtx & {
  setChecklist: (list: ListItem[]) => void
  putListItem: (it: ListItem) => void
  dropListItem: (id: string) => void
}

export const createTasksSlice: Slice<TasksSlice> = (set, get) => {
  const L = lens(set)
  const sys = (cid: string, text: string) => get().pushMsg({ k: 'sys', id: 's' + uid(), text }, cid)
  const helperSays = (cid: string, text: string) => get().pushMsg({ k: 'text', id: 'h' + uid(), from: 'helper', text }, cid)
  const helperTypes = (cid: string, done: () => void, ms: number) => {
    L.typing((t) => ({ ...t, [cid]: 'helper' }))
    later(() => { L.typing((t) => ({ ...t, [cid]: null })); done() }, ms)
  }

  return {
    boards: {},
    commits: [],
    playbook: [],
    checklist: [],

    setChecklist: (checklist) => set({ checklist }),
    putListItem: (it) => L.checklist((l) => (l.some((x) => x.id === it.id) ? l.map((x) => (x.id === it.id ? it : x)) : [...l, it])),
    dropListItem: (id) => L.checklist((l) => l.filter((x) => x.id !== id)),

    claim: (bid, row, who) => {
      const b = get().boards[bid]
      if (live(get())) {
        const task = b?.rows[row]?.task
        const t = task ? get().checklist.find((x) => x.conv === b.conv && x.text === task && x.status === '待认领') : undefined
        if (t) void assignTaskLive(liveCtx(get, set), t.id, who)
        else get().toast('这一行还不在本群清单里，先导入')
        return
      }
      L.boards((all) => ({ ...all, [bid]: { ...all[bid], rows: all[bid].rows.map((r, i) => (i === row ? { ...r, who } : r)) } }))
      get().say(b.conv, who, `我领「${b.rows[row].task}」。`, 500)
    },
    importBoard: (cid, rows) => {
      if (live(get())) {
        if (rows?.length) void createTasksLive(liveCtx(get, set), cid, rows)
        else get().toast('没有要导入的行：先把 CSV 交给 Helper 读出来')
        return
      }
      const bid = 'b' + uid()
      L.boards((b) => ({ ...b, [bid]: { id: bid, title: IMPORTED_BOARD.title, conv: cid, rows: IMPORTED_BOARD.rows.map((task) => ({ task })) } }))
      get().pushMsg({ k: 'board', id: 'bd' + uid(), from: 'helper', boardId: bid }, cid)
      helperSays(cid, '@所有人 任务板建好了，按自己擅长的认领。')
      later(() => L.boards((b) => ({ ...b, [bid]: { ...b[bid], rows: b[bid].rows.map((r, i) => (IMPORTED_BOARD.claims[i] ? { ...r, who: IMPORTED_BOARD.claims[i] } : r)) } })), 1500)
      get().say(cid, 'claude', '我领「登录页深色」。', 1400)
    },

    claimTask: (tid, who) => {
      if (live(get())) { void assignTaskLive(liveCtx(get, set), tid, who); return }
      const t = get().checklist.find((x) => x.id === tid)!
      L.checklist((l) => l.map((x) => (x.id === tid ? { ...x, who, status: '进行中' } : x)))
      sys(t.conv, `${people[who].name} 认领了清单里的「${t.text}」`)
    },
    setTaskStatus: (tid, st) => {
      if (live(get())) { void setTaskStatusLive(liveCtx(get, set), tid, st); return }
      L.checklist((l) => l.map((x) => (x.id === tid ? { ...x, status: st } : x)))
    },
    addTasks: (cid, texts) => {
      if (live(get())) { void createTasksLive(liveCtx(get, set), cid, texts); return }
      L.checklist((l) => [...l, ...texts.map((text) => ({ id: 't' + uid(), conv: cid, text, status: '待认领' as const, attempts: [] }))])
      sys(cid, `Helper 按你的确认，往本群清单加了 ${texts.length} 项`)
      helperSays(cid, `@所有人 清单新加了 ${texts.length} 项，按各自在本群的分工认领。`)
      get().say(cid, 'argon', '我领「飞书接入方案」和「设计规范 v1」，这两项在我的分工里。', 1200)
    },
    addTask: (t) => {
      if (live(get())) { void createTaskLive(liveCtx(get, set), t); return '' }
      const id = 't' + uid()
      const desc = broken('AC-47-2') ? undefined : t.desc
      const who = broken('AC-47-3') ? undefined : t.who
      L.checklist((l) => [...l, { id, conv: t.conv, text: t.text, desc, status: who ? '进行中' : '待认领', who, attempts: [] }])
      sys(t.conv, who ? `你在清单里新建了「${t.text}」，交给 ${people[who].name}` : `你在清单里新建了「${t.text}」，待认领`)
      return id
    },

    summarize: (cid) => {
      /* 摘要覆盖的是按下总结那一刻已有的消息(AC-08:其中任何一条撤回,摘要标过期) */
      const covers = (get().convs.find((c) => c.id === cid)?.messages ?? []).filter((m) => m.k === 'text').map((m) => (m as { id: string }).id)
      set({ stack: [] })
      get().pushMsg({ k: 'text', id: 'me-' + uid(), from: 'me', text: '/总结 我不在时的消息' }, cid)
      helperTypes(cid, () => {
        get().pushMsg({ k: 'summary', id: 'sm' + uid(), from: 'helper', title: SUMMARY_DEMO.title, items: SUMMARY_DEMO.items, covers }, cid)
      }, 1000)
    },
    helperReply: (cid, ask) => {
      helperTypes(cid, () => {
        const c = get().convs.find((x) => x.id === cid)
        const csv = /CSV|csv|清单|任务/.test(ask)
        const group = /拉|新群|另开/.test(ask)
        get().pushMsg({ k: 'text', id: 'h' + uid(), from: 'helper', text: csv ? '读到 4 行。确认后建成本群清单，并 @所有人认领：' : group ? '好，确认一下新群：' : `收到。我读了「${c?.title}」最近 30 条，你想让我做哪一步？`, helper: { scope: `读了本群最近 30 条`, card: csv ? { kind: 'csv', lines: HELPER_CARDS.csv } : group ? { kind: 'group', lines: HELPER_CARDS.group } : undefined } }, cid)
      }, 900)
    },
  }
}
