// 协作切片:任务板、群清单、记下的承诺、协作手册,以及 Helper 在聊天里的总结与回复。
import { people, type Board, type Commitment, type ListItem, type PersonId, type PlaybookItem } from '@/data'
import { broken } from '@/mut'
import { later, uid } from '../boot'
import { HELPER_CARDS, IMPORTED_BOARD, SUMMARY_DEMO } from '../demo'
import { lens, type Slice } from '../state'

/** 这一片经 useApp() 对外暴露的字段(Ctx 的一部分)。加字段:写在这里,再把名字加进下面的 TASKS_CTX_KEYS */
export interface TasksCtx {
  boards: Record<string, Board>
  commits: Commitment[]
  playbook: PlaybookItem[]
  checklist: ListItem[]
  claim: (boardId: string, row: number, who: PersonId) => void
  importBoard: (convId: string) => void
  claimTask: (taskId: string, who: PersonId) => void
  setTaskStatus: (taskId: string, st: ListItem['status']) => void
  addTasks: (convId: string, texts: string[]) => void
  /** 手动新建一项（群资料·清单·新建）：标题、描述分开存，指了人就直接进行中 */
  addTask: (t: { text: string; desc?: string; who?: PersonId; conv: string }) => string
  summarize: (convId: string) => void
  /** 在聊天里 @Helper：回复作为这个聊天的一条消息 */
  helperReply: (convId: string, ask: string) => void
}
export const TASKS_CTX_KEYS = ['boards', 'commits', 'playbook', 'checklist', 'claim', 'importBoard', 'claimTask', 'setTaskStatus', 'addTasks', 'addTask', 'summarize', 'helperReply'] as const satisfies readonly (keyof TasksCtx)[]

export type TasksSlice = TasksCtx

export const createTasksSlice: Slice<TasksSlice> = (set, get) => {
  const L = lens(set)
  const sys = (cid: string, text: string) => get().pushMsg({ k: 'sys', id: 's' + uid(), text }, cid)
  const helperSays = (cid: string, text: string) => get().pushMsg({ k: 'text', id: 'h' + uid(), from: 'helper', text }, cid)
  /** Helper 先亮「正在输入」,过一会儿再出结果 */
  const helperTypes = (cid: string, done: () => void, ms: number) => {
    L.typing((t) => ({ ...t, [cid]: 'helper' }))
    later(() => { L.typing((t) => ({ ...t, [cid]: null })); done() }, ms)
  }

  return {
    /* 初值空:演示数据由 api/demo-state.ts 装 */
    boards: {},
    commits: [],
    playbook: [],
    checklist: [],

    claim: (bid, row, who) => {
      const b = get().boards[bid]
      L.boards((all) => ({ ...all, [bid]: { ...all[bid], rows: all[bid].rows.map((r, i) => (i === row ? { ...r, who } : r)) } }))
      get().say(b.conv, who, `我领「${b.rows[row].task}」。`, 500)
    },
    importBoard: (cid) => {
      const bid = 'b' + uid()
      L.boards((b) => ({ ...b, [bid]: { id: bid, title: IMPORTED_BOARD.title, conv: cid, rows: IMPORTED_BOARD.rows.map((task) => ({ task })) } }))
      get().pushMsg({ k: 'board', id: 'bd' + uid(), from: 'helper', boardId: bid }, cid)
      helperSays(cid, '@所有人 任务板建好了，按自己擅长的认领。')
      later(() => L.boards((b) => ({ ...b, [bid]: { ...b[bid], rows: b[bid].rows.map((r, i) => (IMPORTED_BOARD.claims[i] ? { ...r, who: IMPORTED_BOARD.claims[i] } : r)) } })), 1500)
      get().say(cid, 'claude', '我领「登录页深色」。', 1400)
    },

    claimTask: (tid, who) => {
      const t = get().checklist.find((x) => x.id === tid)!
      L.checklist((l) => l.map((x) => (x.id === tid ? { ...x, who, status: '进行中' } : x)))
      sys(t.conv, `${people[who].name} 认领了清单里的「${t.text}」`)
    },
    setTaskStatus: (tid, st) => L.checklist((l) => l.map((x) => (x.id === tid ? { ...x, status: st } : x))),
    addTasks: (cid, texts) => {
      L.checklist((l) => [...l, ...texts.map((text) => ({ id: 't' + uid(), conv: cid, text, status: '待认领' as const, attempts: [] }))])
      sys(cid, `Helper 按你的确认，往本群清单加了 ${texts.length} 项`)
      helperSays(cid, `@所有人 清单新加了 ${texts.length} 项，按各自在本群的分工认领。`)
      get().say(cid, 'argon', '我领「飞书接入方案」和「设计规范 v1」，这两项在我的分工里。', 1200)
    },
    addTask: (t) => {
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
