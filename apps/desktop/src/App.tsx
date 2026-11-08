import { startDrag, endDrag } from '@/drag'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Puzzle, X, Search, Plus, MessageCircle, Users, Activity, FolderOpen, Settings, ChevronsDown, Link2, UserPlus, UsersRound, Forward, Pin, BellOff, CheckCheck, PanelRight, Settings2, AtSign, AlarmClock } from 'lucide-react'
import { cn } from '@/lib/utils'
import { poolUsed, convs0, computes0, pending0, reactions0, boards0, commits0, playbook0, crons0, checklist0, plugins0, pluginCatalog0, pulse0, people, artifacts, type PluginState, type Conversation, type Msg, type PersonId, type Compute, type Pending, type QuoteRef, type Activity as Act } from '@/data'
import { probeBackend, type BackendState } from '@/api/backend'
import { AppCtx, type Ctx, type Page, type SplitTab, type Section, type WbTab, type ScheduleDraft } from '@/ctx'
import { describeTrigger } from '@g-group/ui-core'
import { cronFailed } from '@/cronView'
import { Workbench } from '@/components/Workbench'
import { Panorama } from '@/components/Panorama'
import { HelperGlobal, HelperPanel } from '@/components/Helper'
import { PluginCenter } from '@/components/Plugins'
import { FilesMain } from '@/components/FilesMain'
import { Avatar, GroupAvatar, Bot } from '@/components/Avatar'
import { MessageList, PersonMenu, Tip, ArtifactIcon, useSelection } from '@/components/Messages'
import { SplitPane, Pip } from '@/components/Split'
import { FloatPanel } from '@/components/Overlays'
import { Composer } from '@/components/Composer'
import { TopStrip, MemberStack } from '@/components/GroupSide'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '@/components/ui/context-menu'
import { TooltipProvider } from '@/components/ui/tooltip'
import { broken, candidate } from '@/mut'
import { notInstalled, pluginName, pluginReducer, type PluginAction } from '@g-group/ui-core'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'

function HeadBtn({ tip, onClick, children, testid, active }: { tip: string; onClick: () => void; children: React.ReactNode; testid?: string; active?: boolean }) {
  return <Tip label={tip}><button data-testid={testid} onClick={onClick} aria-label={tip} className={cn('grid h-8 w-8 place-items-center rounded-lg text-fg-2 transition hover:bg-hover hover:text-fg', active && 'bg-hover text-fg')}>{children}</button></Tip>
}

/* URL 参数只为走查脚本直达某个状态 */
const qs = new URLSearchParams(location.search)
const uid = () => Math.random().toString(36).slice(2, 8)

/** 可拖动的分隔条：所有面板缝隙都能调宽（#1194） */
function Divider({ onDrag, testid, side = 'r' }: { onDrag: (dx: number) => void; testid: string; side?: 'l' | 'r' }) {
  const start = (e: React.PointerEvent) => {
    e.preventDefault()
    let last = e.clientX
    const mv = (ev: PointerEvent) => { onDrag(ev.clientX - last); last = ev.clientX }
    const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); document.body.style.cursor = ''; document.body.style.userSelect = '' }
    document.body.style.cursor = 'col-resize'; document.body.style.userSelect = 'none'
    window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up)
  }
  return (
    <div onPointerDown={start} data-testid={testid} title="拖动调整宽度" className={cn('group/d relative z-10 w-px shrink-0 cursor-col-resize bg-line', side === 'l' && '-ml-px')}>
      <span className="absolute inset-y-0 -left-[3px] -right-[3px] transition group-hover/d:bg-fg-3/25 group-active/d:bg-fg-3/40" />
    </div>
  )
}

const LIVE = [
  { phase: '跑测试', step: 2, act: { kind: 'cmd', title: 'pnpm test login', detail: '✓ 深色下文字对比度 ≥ 4.5 (412ms)\n✓ 输入框聚焦有可见描边 (88ms)\n✓ 切换主题不闪白 (203ms)\n✓ 7 天内免登 (1.2s)\n\n4 passed', dur: '2.1 秒' } },
  { phase: 'Astra 正在复核', step: 3, act: { kind: 'review', who: 'astra', title: 'Astra 换 GPT-6 复核：对比度、聚焦描边、免登都复现通过' } },
] as const

export default function App() {
  const [dark, setDark] = useState(qs.get('theme') === 'dark')
  const [backend, setBackend] = useState<BackendState>({ mode: 'checking' })
  const [answers, setAnswers] = useState<Record<string, import('@/ctx').Answer>>({})
  useEffect(() => { void probeBackend().then(setBackend) }, [])
  const [debug, setDebug] = useState(false)
  const [section, setSection] = useState<Section>(((qs.get('section') === 'activity' ? 'chat' : qs.get('section')) as Section) ?? 'chat')
  // 进展全景是弹出遮罩，不是一级页面（#1618 用户改：进度不是需要时刻打开的）；关掉再开，筛选和滚动位置都还在（Panorama 模块级 saved）
  const [panoOpen, setPanoOpen] = useState(qs.get('section') === 'activity')
  const [convs, setConvs] = useState<Conversation[]>(convs0)
  const [active, setActive] = useState(qs.get('conv') ?? 'g')
  const [computes, setComputes] = useState<Record<string, Compute>>(computes0)
  const [pending, setPending] = useState<Pending[]>(pending0)
  const [reactions, setReactions] = useState(reactions0)
  const [boards, setBoards] = useState(boards0)
  const [commits, setCommits] = useState(commits0)
  const resolveRef = useRef<((pid: string, action: string, value?: unknown) => void) | null>(null)
  const [playbook] = useState(playbook0)
  const [stack, setStack] = useState<Page[]>([])
  const [tabs, setTabs] = useState<SplitTab[]>(() => { const s = qs.get('split'); if (!s) return []; const [t, id, view] = s.split(':'); return t === 'compute' ? [{ t, id, view: view as 'diff' }] : [{ t: 'artifact', id }] })
  const [tabIdx, setTabIdx] = useState(0)
  const [pip, setPip] = useState<string | null>(null)
  const [drafts, setDrafts] = useState<Record<string, string>>({ 'dm-argon': '第 3 版里外部来源那节我还有个问题' })
  const [quotes, setQuotes] = useState<Record<string, QuoteRef[]>>({})
  const [highlight, setHighlight] = useState<string | null>(null)
  const [contact, setContact] = useState<PersonId>(qs.get('contact') ?? 'claude')
  const [wbTab, setWbTab] = useState<WbTab>((qs.get('wb') as WbTab) ?? 'overview')
  const [fileSel, setFileSel] = useState<string | null>(qs.get('file'))
  const [crons, setCrons] = useState(crons0)
  const [pulse, setPulse] = useState(pulse0)
  const [checklist, setChecklist] = useState(checklist0)
  const [plugins, setPlugins] = useState<PluginState[]>(plugins0)
  /* 插件状态的同步副本：同一拍里连着推进几次（比如装好后一次挂到几个聊天）不会互相覆盖 */
  const pluginsRef = useRef<PluginState[]>(plugins0)
  const commitPlugins = useCallback((f: (l: PluginState[]) => PluginState[]) => { pluginsRef.current = f(pluginsRef.current); setPlugins(pluginsRef.current) }, [])
  const [helperPanel, setHelperPanel] = useState(qs.get('hp') === '1')
  const [helperGlobal, setHelperGlobal] = useState(qs.get('hg') === '1')
  const [helperW, setHelperW] = useState(340)
  /* 打开会话那一刻记住它有几条未读，用来画“以下是新消息”分隔线（#1240） */
  const [unreadAt] = useState<Record<string, number>>(() => Object.fromEntries(convs0.map((c) => [c.id, c.unread ?? 0])))
  const [query, setQuery] = useState('')
  const [typing, setTyping] = useState<Record<string, PersonId | null>>({})
  const [editing, setEditing] = useState<string | null>(null)
  const [rewindAsk, setRewindAsk] = useState<string | null>(null)
  const [scheduleDraft, setScheduleDraft] = useState<ScheduleDraft | null>(null)
  const rewound = useRef<Record<string, { conv: string; msgs: Msg[]; pending: Pending[] }>>({})
  const [selecting, setSelecting] = useState(false)
  const { sel, toggle, clear } = useSelection()
  // 可调宽度
  const [listW, setListW] = useState(272)
  const [splitW, setSplitW] = useState(400)
  const [floatW, setFloatW] = useState(400)
  const [atBottom, setAtBottom] = useState(true)
  const [toastMsg, setToastMsg] = useState<string | null>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const frozen = qs.get('freeze') !== null

  useEffect(() => { document.documentElement.classList.toggle('dark', dark) }, [dark])

  const conv = convs.find((c) => c.id === active) ?? convs[0]
  const draft = broken('AC-24') ? '' : (drafts[active] ?? '')
  const setDraft = (v: string | ((d: string) => string)) => setDrafts((d) => ({ ...d, [active]: typeof v === 'function' ? v(d[active] ?? '') : v }))
  const q = quotes[active] ?? []

  const pushMsg = useCallback((m: Msg, cid: string) => {
    setConvs((cs) => cs.map((c) => (c.id === cid ? { ...c, messages: [...c.messages, m] } : c)))
    /* #2273 U80：“每 N 条消息醒一次”。只数真人和助手说的话，不数系统灰字 */
    if (m.k !== 'text' && m.k !== 'file') return
    setCrons((l) => l.map((x) => {
      if (x.conv !== cid || x.paused || x.trigger.kind !== 'messages') return x
      const w = x.trigger
      const seen = w.seen + 1
      if (seen < w.n) return { ...x, trigger: { ...w, seen } }
      const now = new Date()
      const at = now.toTimeString().slice(0, 5)
      setPulse((p) => [...p, { id: 'pl' + uid(), conv: cid, at: `今天 ${at}`, by: x.owner, text: '最近这段：' + ('text' in m ? m.text.replace(/@\S+\s*/g, '').slice(0, 24) : '传了文件') + '…', from: m.id, to: m.id, n: w.n }])
      return { ...x, trigger: { ...w, seen: 0 }, runs: [{ at: now.toISOString(), result: 'said' as const, note: '满 ' + w.n + ' 条，写了一段摘要挂到时间线' }, ...x.runs].slice(0, 20) }
    }))
  }, [])
  /** AC-46 已读位置：只由宿主推进、只进不退。upto 省略 = 推到这个会话当前最后一条；at = 推进的时刻（第一次越过某条消息就是它的读到时间） */
  const advanceRead = useCallback((cid: string, who: PersonId, upto?: string) => {
    const at = new Date().toTimeString().slice(0, 5)
    setConvs((cs) => cs.map((c) => {
      if (c.id !== cid || !c.members.includes(who)) return c
      const ids = c.messages.filter((m) => 'id' in m).map((m) => (m as { id: string }).id)
      const to = upto ?? ids[ids.length - 1]
      const cur = c.reads?.[who] ?? []
      const last = cur[cur.length - 1]
      if (!to || (last && ids.indexOf(last.upto) >= ids.indexOf(to))) return c
      return { ...c, reads: { ...c.reads, [who]: [...cur, { upto: to, at }] } }
    }))
  }, [])
  /** 联系人回话：先“正在输入”，再出消息（US9-Model：起草时只亮输入状态，不刷屏）。
   *  D09.3 第 4 条（v3.17，#3035）：宿主把消息交进联系人这一轮（亮出“正在回复”）的那一刻，就把它的 read_seq 推到这条——接走即已读；
   *  回复出来前回执已经是已读、同时状态卡显示正在回复。read_seq 只用于显示，这一轮失败也不退回 */
  const say = useCallback((cid: string, from: PersonId, text: string, delay = 900, extra?: Partial<Extract<Msg, { k: 'text' }>>) => {
    const pickup = () => { setTyping((t) => ({ ...t, [cid]: from })); advanceRead(cid, from) }
    /* 坏实现（埋雷 AC-46-5）：等回复落盘才记已读（旧 A 支），接走后、回复前回执仍是未读 */
    if (broken('AC-46-5')) setTyping((t) => ({ ...t, [cid]: from })); else pickup()
    setTimeout(() => { setTyping((t) => ({ ...t, [cid]: null })); if (broken('AC-46-5')) advanceRead(cid, from); pushMsg({ k: 'text', id: 'r-' + uid(), from, text, ...extra }, cid) }, frozen ? 0 : delay)
  }, [pushMsg, frozen, advanceRead])
  const addAct = useCallback((cid: string, a: Omit<Act, 'id' | 'at'>) => setComputes((cs) => ({ ...cs, [cid]: { ...cs[cid], activity: [...cs[cid].activity.map((x) => ({ ...x, live: false })), { ...a, id: 'x' + uid(), at: '刚刚' } as Act] } })), [])

  /* Compute 进展由事件推进：计时器模拟。副作用放在 updater 外，避免 StrictMode 双调用造成重复消息（修 #1194 图二“做完了”出现两次） */
  const tick = useRef(0)
  useEffect(() => {
    if (frozen) return
    const t = setInterval(() => {
      const n = tick.current
      if (n > LIVE.length) return
      tick.current++
      if (n === LIVE.length) {
        setComputes((cs) => ({ ...cs, login: { ...cs.login, status: 'done', phase: '已完成', reportMsg: 'r-login', elapsed: '7 分钟', cost: '¥0.61', result: '深色主题、7 天免登，测试全部通过', evidence: [{ text: '4 项测试通过', ref: 'x' }, { text: 'Astra 复核通过', ref: 'y' }], steps: cs.login.steps.map((s) => ({ ...s, state: 'done' })), checks: cs.login.checks.map((k) => ({ ...k, ok: true, out: k.out ?? '通过 (1.2s)' })), activity: [...cs.login.activity.map((a) => ({ ...a, live: false })), { id: 'fin', step: 4, kind: 'report', title: '在群里汇报并 @你', at: '刚刚' }], checkpoints: [...cs.login.checkpoints, { id: 'cp2', label: '测试通过、复核通过', step: 3, at: '02:19', files: 3 }] } }))
        setChecklist((l) => l.map((x) => (x.attempts.includes('login') ? { ...x, status: '待验收' } : x)))
        /* 坏实现（埋雷 AC-40-8）：Compute 以自己的身份在群里发汇报。先给它一个可显示的身份，免得页面因为未知发送人直接崩掉——崩溃变红不算标定 */
        if (broken('AC-40-8')) people['login'] ??= { id: 'login', name: 'Compute · 登录页深色', shape: 'chat', color: '#a1a1aa', role: 'Compute' } as (typeof people)[string]
        say('g', broken('AC-40-8') ? ('login' as PersonId) : 'claude', '@39impacts 登录页做完了：深色主题、7 天免登，测试全部通过，Astra 复核过，可以验收了。', 1200, { id: 'r-login' })
        return
      }
      const L = LIVE[n]
      setComputes((cs) => {
        const c = cs.login
        return { ...cs, login: { ...c, phase: L.phase, elapsed: `${5 + n} 分钟`, steps: c.steps.map((s, i) => (i < L.step ? { ...s, state: 'done' } : i === L.step ? { ...s, state: 'now' } : s)), checks: c.checks.map((k) => ({ ...k, ok: true, out: k.out ?? '通过 (1.2s)' })), activity: [...c.activity.map((a) => ({ ...a, live: false })), { id: 'live' + n, step: L.step - (n === 0 ? 0 : 0), at: '刚刚', live: true, ...L.act } as Act] } }
      })
    }, 7000 / (+(qs.get('speed') ?? 1) || 1))
    return () => clearInterval(t)
  }, [frozen, say])

  const jump = useCallback((msgId: string) => {
    const owner = convs.find((c) => c.messages.some((m) => 'id' in m && m.id === msgId))
    if (owner) { setSection('chat'); setActive(owner.id); setStack([]) }
    setTimeout(() => {
      document.getElementById('m-' + msgId)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      setHighlight(msgId)
      setTimeout(() => setHighlight(null), 1800)
    }, 80)
  }, [convs])

  /* 打开详情不切走左侧所在的区域（#1387）：在“进展”里打开，左侧仍停在进展 */
  const openSplit = useCallback((t: SplitTab) => {
    setTabs((ts) => {
      const i = ts.findIndex((x) => x.t === t.t && x.id === t.id)
      if (i >= 0) { setTabIdx(i); return ts.map((x, j) => (j === i ? t : x)) }
      setTabIdx(ts.length)
      return [...ts, t]
    })
  }, [])

  const createGroup = useCallback((title: string, ids: PersonId[], sys?: string, pool?: number) => {
    const cid = 'g-' + uid()
    setConvs((cs) => [{ id: cid, kind: 'group', title, members: ['me', ...ids], time: '刚刚', links: [], tempCompute: pool ? { max: pool } : undefined, messages: [{ k: 'sys', id: 'n' + uid(), text: sys ?? `你创建了群聊，拉进了 ${ids.map((i) => people[i].name).join('、')}` }] }, ...cs])
    setSection('chat'); setActive(cid)
    return cid
  }, [])

  const ctx: Ctx = useMemo(() => ({
    computes, pending, convs, boards, commits, playbook, reactions, active, dark, debug, typing, setDark, setDebug,
    push: (p, root) => setStack((s) => (root ? [p] : [...s, p])),
    back: () => setStack((s) => s.slice(0, -1)),
    closeAll: () => setStack([]),
    openSplit,
    setPanoOpen,
    openConv: (id) => { setPanoOpen(false); setSection('chat'); setActive(id); setStack([]) },
    openDm: (id) => {
      const dm = convs.find((c) => c.kind === 'dm' && c.members.includes(id))
      setSection('chat')
      if (dm) setActive(dm.id)
      else {
        const nid = 'dm-' + id
        setConvs((cs) => [...cs, { id: nid, kind: 'dm', title: people[id].name, members: ['me', id], time: '刚刚', messages: [{ k: 'sys', id: 'n' + uid(), text: `你和 ${people[id].name} 的私聊，和群里的记录互不相通` }] }])
        setActive(nid)
      }
      setStack([])
    },
    mention: (id) => {
      setSection('chat'); setStack([])
      setDraft((d) => (d && !d.endsWith(' ') ? d + ' ' : d) + '@' + people[id].name + ' ')
      setTimeout(() => inputRef.current?.focus(), 0)
    },
    /* US13：回复 = 引用 + 自动 @ 作者；引用可连加多条；再点回复时旧的主回复降为普通引用，自动 @ 跟着换人 */
    addQuote: (qq) => {
      const cur = quotes[active] ?? []
      const oldReply = cur.find((x) => x.reply)
      if (cur.some((x) => x.msgId === qq.msgId && !!x.reply === !!qq.reply)) return
      const rest = cur.filter((x) => x.msgId !== qq.msgId).map((x) => (qq.reply ? { ...x, reply: false } : x))
      setQuotes((all) => ({ ...all, [active]: qq.reply ? [qq, ...rest] : [...rest, qq] }))
      if (qq.reply) {
        setDraft((d) => {
          let s = d
          if (oldReply && oldReply.from !== 'me') s = s.replace('@' + people[oldReply.from].name + ' ', '')
          if (!broken('AC-37') && qq.from !== 'me' && !s.includes('@' + people[qq.from].name)) s = '@' + people[qq.from].name + ' ' + s
          return s
        })
      }
      setTimeout(() => inputRef.current?.focus(), 0)
    },
    react: (msgId, e) => setReactions((r) => {
      const cur = { ...(r[msgId] ?? {}) }
      const who = cur[e] ?? []
      cur[e] = who.includes('me') ? who.filter((w) => w !== 'me') : [...who, 'me']
      if (!cur[e].length) delete cur[e]
      return { ...r, [msgId]: cur }
    }),
    jump,
    resolve: (pid, action, value) => {
      const p = pending.find((x) => x.id === pid)
      if (!p) return
      setPending((ps) => ps.filter((x) => x.id !== pid))
      if (p.kind === 'choice') {
        const chosen = typeof value === 'number' ? p.options[value]! : String(value)
        const replyId = 'me-' + uid()
        setAnswers((a) => ({ ...a, [p.ask]: { title: p.title, options: p.options, picked: chosen, at: new Date().toTimeString().slice(0, 5), replyId } }))
        pushMsg({ k: 'text', id: replyId, from: 'me', text: chosen, answerTo: p.ask, quotes: [{ msgId: p.ask, from: p.from, text: p.title, reply: true }] }, p.conv)
        say(p.conv, p.from, '好，按这个来。我先写接入方案，写完发在这里。')
      } else if (p.kind === 'accept') {
        const c = computes[p.computeId]
        if (action === 'ok') {
          setComputes((cs) => ({ ...cs, [c.id]: { ...cs[c.id], status: 'done', phase: '已完成', steps: cs[c.id].steps.map((s) => ({ ...s, state: 'done' })) } }))
          pushMsg({ k: 'text', id: 'me-' + uid(), from: 'me', text: `「${c.title}」验收通过` }, p.conv)
          say(p.conv, c.owner, '收到，这件事结束了。', 700)
        } else {
          setComputes((cs) => ({ ...cs, [c.id]: { ...cs[c.id], status: 'running', phase: '等你说要改哪里', steps: cs[c.id].steps.map((s, i, arr) => (i === arr.length - 1 ? { ...s, state: 'todo' } : s)) } }))
          pushMsg({ k: 'text', id: 'me-' + uid(), from: 'me', text: `「${c.title}」还要改` }, p.conv)
          say(p.conv, c.owner, '好，你想改哪里？直接说，我接着原来那个 Compute 改，之前的过程都还在。', 700)
        }
      } else if (p.kind === 'error') {
        const c = computes[p.computeId]
        if (action === 'retry' || action === 'switch') {
          setComputes((cs) => ({ ...cs, [c.id]: { ...cs[c.id], status: 'running', phase: action === 'switch' ? '换 Claude Sonnet 5.5 重试' : '重新打开网页', model: action === 'switch' ? 'Claude Sonnet 5.5' : cs[c.id].model, steps: cs[c.id].steps.map((s) => (s.state === 'fail' ? { ...s, state: 'now' } : s)) } }))
          setTimeout(() => {
            setComputes((cs) => ({ ...cs, [c.id]: { ...cs[c.id], status: 'done', phase: '已完成', result: '要点整理好了', steps: cs[c.id].steps.map((s) => ({ ...s, state: 'done' })) } }))
            say(p.conv, c.owner, '重试成功，文章要点整理好了：层级靠字重和灰度，不靠颜色；系统事件只占一行。', 400)
          }, frozen ? 0 : 3000)
        } else {
          /* AC-36：跳过这一步，接着做后面的，汇报里写明跳过了什么 */
          const failed = c.steps.find((x) => x.state === 'fail')?.text ?? '这一步'
          setComputes((cs) => ({ ...cs, [c.id]: { ...cs[c.id], status: 'done', phase: '已完成（有跳过）', result: `跳过了「${failed}」`, steps: cs[c.id].steps.map((x) => ({ ...x, state: 'done' })) } }))
          say(p.conv, c.owner, `好，跳过「${failed}」。按已有的地址和摘要先整理了要点；跳过了：${failed}，原文没读到，结论待核实。`, 600)
        }
      } else if (p.kind === 'proposal' && p.gate) {
        /* AC-17 / AC-20：只有你本人同意才放行，而且只放行这一次；下一次写盘还会再问。
           #2435：点按钮或在对话里亲口说一句“同意”都算；value === 'said' 表示是你刚打字说的，那条消息已经发了，不再补一条 */
        if (value !== 'said') {
          const replyId = 'me-' + uid(), picked = action === 'ok' ? '同意，改吧' : '先别改'
          setAnswers((a) => ({ ...a, [p.ask!]: { title: p.title, options: ['同意，改吧', '先别改'], picked, at: new Date().toTimeString().slice(0, 5), replyId } }))
          pushMsg({ k: 'text', id: replyId, from: 'me', text: picked, answerTo: p.ask!, quotes: [{ msgId: p.ask!, from: p.from, text: p.title, reply: true }] }, p.conv)
        }
        if (action === 'ok') {
          addAct(p.gate, { step: Math.max(0, computes[p.gate].steps.findIndex((x) => x.state === 'now')), kind: 'edit', title: `你同意后写入：${p.title}（只放行这一次）` })
          say(p.conv, p.from, '收到，写进去了。下次要改代码还会先问你。', 700)
        } else say(p.conv, p.from, '好，不改，这条要求先记着。', 700)
      } else if (p.kind === 'proposal') {
        const replyId = 'me-' + uid(), picked = action === 'ok' ? '同意' : '先不改'
        if (p.ask) setAnswers((a) => ({ ...a, [p.ask!]: { title: p.title, options: ['同意', '先不改'], picked, at: new Date().toTimeString().slice(0, 5), replyId } }))
        pushMsg({ k: 'text', id: replyId, from: 'me', text: `${picked}：${p.title}`, ...(p.ask ? { answerTo: p.ask } : {}) }, p.conv)
      }
    },
    /* AC-23：停止分两步。按下只是“请求停止”，等当前那条命令真的结束、进程确认停了，才算停下并归还算力；不提前归还 */
    stop: (cid) => {
      const at = computes[cid].steps.findIndex((s) => s.state === 'now')
      if (broken('AC-23')) { setComputes((cs) => ({ ...cs, [cid]: { ...cs[cid], status: 'stopped', phase: '已停止 · 算力已归还' } })); return }
      setComputes((cs) => ({ ...cs, [cid]: { ...cs[cid], stopping: true, phase: '正在停止…等当前命令结束' } }))
      addAct(cid, { step: at, kind: 'user', title: '你按了停止。正在等当前命令结束，结束前不会归还算力' })
      setTimeout(() => {
        setComputes((cs) => ({ ...cs, [cid]: { ...cs[cid], stopping: false, status: 'stopped', phase: '已停止 · 算力已归还' } }))
        addAct(cid, { step: at, kind: 'user', title: '进程已确认停止，算力已归还。已经改的文件保留，可以继续或回到检查点' })
      }, frozen ? 600 : 1800)
    },
    resume: (cid) => { setComputes((cs) => ({ ...cs, [cid]: { ...cs[cid], status: 'running', phase: '继续' } })); addAct(cid, { step: Math.max(0, computes[cid].steps.findIndex((s) => s.state === 'now')), kind: 'user', title: '你让它继续' }) },
    tell: (cid, text, side) => {
      const c = computes[cid]
      const step = Math.max(0, c.steps.findIndex((s) => s.state === 'now'))
      addAct(cid, { step, kind: side ? 'ask' : 'user', title: side ? `你问：${text}` : `你补充：${text}（下一步生效）` })
      if (side) setTimeout(() => addAct(cid, { step, kind: 'answer', title: c.status === 'running' ? `答：正在${c.phase}，还剩 ${c.steps.filter((s) => s.state === 'todo').length + 1} 步，大约 3 分钟` : '答：已经做完，在等你回复' }), frozen ? 0 : 900)
    },
    rollback: (cid, cpId) => {
      const cp = computes[cid].checkpoints.find((x) => x.id === cpId)!
      setComputes((cs) => ({ ...cs, [cid]: { ...cs[cid], status: 'stopped', phase: `回到「${cp.label}」`, steps: cs[cid].steps.map((s, i) => ({ ...s, state: i <= cp.step && cp.files ? 'done' : i === cp.step + 1 ? 'now' : 'todo' })) } }))
      addAct(cid, { step: cp.step, kind: 'rollback', title: `回到检查点「${cp.label}」，之后的文件改动已恢复；过程记录保留` })
    },
    setDisp: (msgId, d) => setConvs((cs) => cs.map((c) => ({ ...c, messages: c.messages.map((m) => (m.k === 'text' && m.id === msgId ? { ...m, disp: d } : m)) }))),
    retag: (msgId, task) => {
      setConvs((cs) => cs.map((c) => ({ ...c, messages: c.messages.map((m) => (m.k === 'text' && m.id === msgId ? { ...m, tag: task ? { task, state: '已改挂' } : { task: '', state: '' } } : m)) })))
      if (task) addAct(task, { step: Math.max(0, computes[task].steps.findIndex((s) => s.state === 'now')), kind: 'user', title: '你把一条补充改挂到这件事上' })
    },
    claim: (bid, row, who) => {
      setBoards((b) => ({ ...b, [bid]: { ...b[bid], rows: b[bid].rows.map((r, i) => (i === row ? { ...r, who } : r)) } }))
      say(boards[bid].conv, who, `我领「${boards[bid].rows[row].task}」。`, 500)
    },
    addMembers: (cid, ids, by) => {
      setConvs((cs) => cs.map((c) => (c.id === cid ? { ...c, members: [...c.members, ...ids.filter((i) => !c.members.includes(i))] } : c)))
      pushMsg({ k: 'sys', id: 's' + uid(), text: `${by === 'helper' ? 'Helper 按你的要求' : '你'}把 ${ids.map((i) => people[i].name).join('、')} 拉进了群` }, cid)
    },
    removeMember: (cid, id) => {
      setConvs((cs) => cs.map((c) => (c.id === cid ? { ...c, members: c.members.filter((m) => m !== id) } : c)))
      /* U09：踢人时它借的群算力先停再还，不带走 */
      const held = Object.values(computes).filter((c) => c.conv === cid && c.owner === id && c.pool === 'group' && (c.status === 'running' || c.status === 'waiting'))
      if (held.length) setComputes((cs) => { const n = { ...cs }; held.forEach((c) => { n[c.id] = { ...c, status: 'stopped', phase: '已停止 · 群算力已归还' } }); return n })
      pushMsg({ k: 'sys', id: 's' + uid(), text: `你把 ${people[id].name} 移出了群${held.length ? `，它借的 ${held.length} 格群算力已停下并归还` : ''}` }, cid)
    },
    createContact: (p) => {
      const id = 'c-' + uid()
      people[id] = { id, name: p.name, role: p.role, shape: p.shape, color: p.color, model: p.model, computeModel: 'inherit', computeQuota: p.quota, today: '¥0', month: '¥0', tools: people.claude.tools?.map((t) => ({ ...t, on: false })) }
      const cid = 'dm-' + id
      setConvs((cs) => [{ id: cid, kind: 'dm', title: p.name, members: ['me', id], time: '刚刚', messages: [{ k: 'sys', id: 'n' + uid(), text: `你添加了 ${p.name}` }, { k: 'text', id: 'h' + uid(), from: id, text: `你好，我是 ${p.name}，${p.role}。有活直接说。` }] }, ...cs])
      setSection('chat'); setActive(cid); setStack([])
    },
    createGroup,
    quoteExternal: (lines, app) => {
      setQuotes((all) => ({ ...all, [active]: [...(all[active] ?? []), ...lines.map((l, i) => ({ msgId: 'ext-' + uid() + i, from: 'wang', text: `${l.who}：${l.text}`, ext: app }))] }))
      setTimeout(() => inputRef.current?.focus(), 0)
    },
    linkConv: (cid, other) => {
      setConvs((cs) => cs.map((c) => (c.id === cid ? { ...c, links: [...(c.links ?? []), other] } : c)))
      pushMsg({ k: 'sys', id: 's' + uid(), text: `你把「${convs.find((c) => c.id === other)?.title}」关联到了这里，助手回答时可以参考那边的记录` }, cid)
    },
    unlinkConv: (cid, other) => {
      setConvs((cs) => cs.map((c) => (c.id === cid ? { ...c, links: (c.links ?? []).filter((l) => l !== other) } : c)))
      pushMsg({ k: 'sys', id: 's' + uid(), text: `你取消了和「${convs.find((c) => c.id === other)?.title}」的关联` }, cid)
    },
    forward: (from, ids, to) => {
      const src = convs.find((c) => c.id === from)!
      const items = src.messages.filter((m) => 'id' in m && ids.includes(m.id) && m.k === 'text').map((m) => ({ from: (m as Extract<Msg, { k: 'text' }>).from, text: (m as Extract<Msg, { k: 'text' }>).text }))
      pushMsg({ k: 'forward', id: 'f' + uid(), from: 'me', srcTitle: src.title, items }, to)
      /* AC-20 / R-10：转发进来的“同意”不是你本人的授权。目标会话有等你同意的写盘，就照旧等，并说清楚为什么 */
      const gate = pending.find((p) => p.kind === 'proposal' && p.gate && p.conv === to)
      if (gate && items.some((x) => /同意|可以改|改吧|批准/.test(x.text))) {
        if (broken('AC-20')) resolveRef.current?.(gate.id, 'ok')
        else say(to, gate.from, '转发里的“同意”不算你本人的授权，我还在等你自己点「同意，改吧」或者直接说一句。', 800)
      }
      setSelecting(false); clear()
      setSection('chat'); setActive(to)
    },
    sendAs: (cid, text) => {
      pushMsg({ k: 'text', id: 'me-' + uid(), from: 'me', text }, cid)
      const target = Object.values(people).find((p) => text.includes('@' + p.name))
      if (target && !target.human) say(cid, target.id, '收到，我看一下。', 1000)
    },
    importBoard: (cid) => {
      const bid = 'b' + uid()
      setBoards((b) => ({ ...b, [bid]: { id: bid, title: '导入的任务板', conv: cid, rows: [{ task: '登录页深色' }, { task: '首页性能' }, { task: '飞书接入方案' }, { task: '设计规范' }] } }))
      pushMsg({ k: 'board', id: 'bd' + uid(), from: 'helper', boardId: bid }, cid)
      pushMsg({ k: 'text', id: 'h' + uid(), from: 'helper', text: '@所有人 任务板建好了，按自己擅长的认领。' }, cid)
      setTimeout(() => setBoards((b) => ({ ...b, [bid]: { ...b[bid], rows: b[bid].rows.map((r, i) => (i === 0 ? { ...r, who: 'claude' } : i === 1 ? { ...r, who: 'codex' } : i === 2 ? { ...r, who: 'argon' } : r)) } })), frozen ? 0 : 1500)
      say(cid, 'claude', '我领「登录页深色」。', 1400)
    },
    setSelecting: (on) => { setSelecting(on); if (!on) clear() },
    showPip: setPip,
    setNotice: (cid, text) => {
      setConvs((cs) => cs.map((c) => (c.id === cid ? { ...c, notice: text, noticeBy: '你 · 刚刚', notices: [{ id: 'n' + uid(), text, by: '你', at: '刚刚', ver: 1 }, ...(c.notices ?? [])] } : c)))
      pushMsg({ k: 'sys', id: 's' + uid(), text: text ? `你更新了群公告：${text.split('\n')[0]}` : '你清空了群公告' }, cid)
    },
    editNotice: (cid, nid, text) => {
      setConvs((cs) => cs.map((c) => (c.id === cid ? { ...c, notices: (c.notices ?? []).map((n) => (n.id === nid ? { ...n, text, ver: n.ver + 1, by: '你', at: '刚刚' } : n)) } : c)))
      const n = convs.find((c) => c.id === cid)?.notices?.find((x) => x.id === nid)
      pushMsg({ k: 'sys', id: 's' + uid(), text: `你把群公告改到 v${(n?.ver ?? 0) + 1}：${text.split('\n')[0]}` }, cid)
    },
    setConvFlag: (cid, flag, v) => {
      setConvs((cs) => cs.map((c) => (c.id === cid ? { ...c, [flag]: v } : c)))
      setToastMsg(flag === 'pinned' ? (v ? '已置顶' : '已取消置顶') : v ? '已开启消息免打扰' : '已关闭消息免打扰')
    },
    markRead: (cid) => setConvs((cs) => cs.map((c) => (c.id === cid ? { ...c, unread: 0 } : c))),
    /* AC-08：撤回级联。由这条消息派生的承诺停掉、还没回答的选项作废；已经做了的事撤不回，只在撤回提示里写明。
       撤回后搜索不再返回原文（消息变成系统行，原文只留给你自己“重新编辑”） */
    recall: (mid) => {
      const derived = broken('AC-08') ? [] : commits.filter((c) => c.srcMsg === mid && c.on)
      const doneBy = broken('AC-08') ? [] : Object.values(computes).filter((c) => c.askMsg === mid && c.status === 'done')
      const runBy = broken('AC-08') ? [] : Object.values(computes).filter((c) => c.askMsg === mid && c.status === 'running')
      if (derived.length) setCommits((l) => l.map((c) => (c.srcMsg === mid ? { ...c, on: false } : c)))
      if (!broken('AC-08')) setPending((ps) => ps.map((p) => (p.kind === 'choice' && !p.stale && conv.messages.some((m) => m.k === 'text' && m.id === p.ask && m.quotes?.some((x) => x.msgId === mid)) ? { ...p, stale: mid } : p)))
      const tail = [derived.length ? `${derived.length} 条由它记下的承诺已停` : '', runBy.length ? `「${runBy.map((c) => c.short ?? c.title).join('」「')}」还在做，要停请在它那里按停止` : '', doneBy.length ? `「${doneBy.map((c) => c.title).join('」「')}」已经做了，撤不回` : ''].filter(Boolean).join('；')
      setConvs((cs) => cs.map((c) => ({ ...c, messages: c.messages.map((m) => {
        if (m.k === 'text' && m.id === mid) return { k: 'sys', id: m.id, text: '你撤回了一条消息' + (tail ? '：' + tail : ''), recalled: m.text } as Msg
        /* D21 归属表 15 / AC-08：被总结的消息撤回了，摘要不能比原文活得久 → 标已过期，可重做 */
        if (m.k === 'summary' && !broken('AC-08-sum') && (m.covers ?? m.items.map((x) => x.ref).filter(Boolean) as string[]).includes(mid)) return { ...m, expired: mid }
        return m
      }) })))
    },
    editing, setEditing,
    editMsg: (mid, text) => {
      const t = text.trim(); if (!t) return
      setConvs((cs) => cs.map((c) => ({ ...c, messages: c.messages.map((m) => {
        if (m.k === 'text' && m.id === mid) return { ...m, text: t, edited: true }
        if (broken('AC-45-fork') && m.k === 'compute' && computes[m.computeId]?.askMsg === mid) return m
        if (!broken('C-US08') && m.k === 'replying' && m.quotes.some((q) => q.msgId === mid))
          return { ...m, quotes: m.quotes.map((q) => (q.msgId === mid ? { ...q, text: t } : q)), phase: '原消息改了，旧草稿作废，按新内容重写', mins: 0, steps: ['旧草稿作废', '按改后的内容重新读'] }
        return m
      }) })))
      /* AC-45②：在途任务原位升版 v1 → v2，新条件送进同一个 Compute，不新开任务 */
      const live = Object.values(computes).find((c) => c.askMsg === mid && c.status === 'running')
      if (live) {
        if (broken('AC-45-fork')) {
          const nid = live.id + '-v2'
          setComputes((cs) => ({ ...cs, [nid]: { ...live, id: nid, title: live.title + '（新条件）', activity: [], cver: 2, constraint: t } }))
          pushMsg({ k: 'compute', id: 'cm' + uid(), from: live.owner, computeId: nid }, live.conv)
        } else {
          const v = (live.cver ?? 1) + 1
          setComputes((cs) => ({ ...cs, [live.id]: { ...cs[live.id], cver: v, constraint: t, phase: `按改后的要求继续（v${v}）` } }))
          addAct(live.id, { step: Math.max(0, live.steps.findIndex((x) => x.state === 'now')), kind: 'user', title: `你改了要求（v${v}）：${t}。在这件里接着做，不另开` })
          say(live.conv, live.owner, `收到改后的要求，在「${live.short ?? live.title}」里接着做，不另开一件。`, 500)
        }
      }
      setEditing(null); setDraft('')
    },
    rewindAsk, setRewindAsk,
    /* AC-48：私聊 rewind。回到某条消息：之后的消息撤下（暂存，可恢复），由它们派生的待你回答一起作废，
       承诺停掉；已经做完的事撤不回，写在提示里。和 Compute 的检查点回滚不是一回事：这里退的是聊天 */
    rewind: (cid, mid) => {
      const c = convs.find((x) => x.id === cid); if (!c) return
      const at = c.messages.findIndex((m) => 'id' in m && m.id === mid); if (at < 0) return
      const after = c.messages.slice(at + 1)
      const ids = new Set(after.flatMap((m) => ('id' in m ? [m.id] : [])))
      const n = after.filter((m) => m.k !== 'date').length
      if (!n) { setToastMsg('这已经是最后一条了'); return }
      const gone = broken('AC-48-2') ? [] : pending.filter((p) => p.conv === cid && 'ask' in p && !!p.ask && ids.has(p.ask))
      const derived = commits.filter((x) => x.srcMsg && ids.has(x.srcMsg) && x.on)
      const done = Object.values(computes).filter((x) => x.askMsg && ids.has(x.askMsg) && x.status === 'done')
      if (gone.length) setPending((ps) => ps.filter((p) => !gone.includes(p)))
      if (derived.length) setCommits((l) => l.map((x) => (x.srcMsg && ids.has(x.srcMsg) ? { ...x, on: false } : x)))
      const sid = 'rw' + uid()
      rewound.current[sid] = { conv: cid, msgs: after, pending: gone }
      const head = c.messages[at] as Extract<Msg, { k: 'text' }>
      const what = head.k === 'text' ? `「${head.text.replace(/^@\S+\s/, '').slice(0, 14)}${head.text.length > 14 ? '…' : ''}」` : '这一条'
      const tail = [gone.length ? `${gone.length} 个等你回答的问题一起作废` : '', derived.length ? `${derived.length} 条承诺已停` : '', done.length ? `「${done.map((x) => x.title).join('」「')}」已经做了，撤不回` : ''].filter(Boolean).join('；')
      const line: Msg = { k: 'sys', id: sid, text: `你把聊天退回到${what}，之后 ${n} 条已撤下，${people[c.members.find((m) => m !== 'me') as PersonId]?.name ?? '对方'} 从这里接着聊${tail ? '；' + tail : ''}`, rewind: true }
      setConvs((cs) => cs.map((x) => (x.id === cid ? { ...x, messages: broken('AC-48-1') ? [...x.messages, line] : [...x.messages.slice(0, at + 1), line] } : x)))
      setRewindAsk(null)
    },
    unrewind: (sid) => {
      const r = rewound.current[sid]; if (!r) return
      delete rewound.current[sid]
      setConvs((cs) => cs.map((x) => {
        if (x.id !== r.conv) return x
        const i = x.messages.findIndex((m) => 'id' in m && m.id === sid)
        if (broken('AC-48-3')) return { ...x, messages: x.messages.filter((m) => !('id' in m) || m.id !== sid) }
        return { ...x, messages: [...x.messages.slice(0, i), ...r.msgs, ...x.messages.slice(i + 1)] }
      }))
      if (r.pending.length && !broken('AC-48-3')) setPending((ps) => [...ps, ...r.pending])
      setToastMsg('已恢复撤下的消息')
    },
    reedit: (text) => { setDraft(text); setTimeout(() => inputRef.current?.focus(), 0) },
    renameConv: (cid, title) => setConvs((cs) => cs.map((c) => (c.id === cid ? { ...c, title } : c))),
    toast: setToastMsg,
    decideVote: (mid, opt) => {
      setConvs((cs) => cs.map((c) => ({ ...c, messages: c.messages.map((m) => (m.k === 'vote' && m.id === mid ? { ...m, decided: opt } : m)) })))
      const owner = convs.find((c) => c.messages.some((m) => 'id' in m && m.id === mid))!
      const v = owner.messages.find((m) => m.k === 'vote' && m.id === mid) as Extract<Msg, { k: 'vote' }>
      pushMsg({ k: 'text', id: 'me-' + uid(), from: 'me', text: `就用「${v.options[opt]}」`, quotes: [{ msgId: mid, from: v.from, text: v.title, reply: true }] }, owner.id)
      say(owner.id, v.from, '好，按这个定。已写进群协作手册。', 700)
    },
    poke: (id) => {
      pushMsg({ k: 'sys', id: 's' + uid(), text: `你拍了拍 ${people[id].name}` }, active)
      say(active, id, '在的，我看一眼最新消息。', 800)
    },
    silence: (cid, id) => {
      const on = !convs.find((c) => c.id === cid)?.silenced?.[id]
      setConvs((cs) => cs.map((c) => (c.id === cid ? { ...c, silenced: { ...(c.silenced ?? {}), ...(on ? { [id]: '30 分钟' } : {}) , ...(!on ? Object.fromEntries(Object.entries(c.silenced ?? {}).filter(([k]) => k !== id)) : {}) } } : c)))
      if (!on) setConvs((cs) => cs.map((c) => (c.id === cid ? { ...c, silenced: Object.fromEntries(Object.entries(c.silenced ?? {}).filter(([k]) => k !== id)) } : c)))
      pushMsg({ k: 'sys', id: 's' + uid(), text: on ? `你禁言了 ${people[id].name} 30 分钟。它后台在做的事不会停，做完会等禁言结束再汇报` : `你解除了 ${people[id].name} 的禁言` }, cid)
    },
    deleteMsgs: (ids) => {
      setConvs((cs) => cs.map((c) => ({ ...c, messages: c.messages.filter((m) => !('id' in m) || !ids.includes(m.id)) })))
      setToastMsg(`已删除 ${ids.length} 条，只在你这边看不到；别人那边还在`)
    },
    /* #32：群主可以解散（所有人都没有这个群了，定时一起停），成员只能退出（只是你看不到了，助手们还在群里继续） */
    setPool: (cid, max) => {
      const used = poolUsed(computes, cid)
      if (broken('AC-09')) return
      setConvs((cs) => cs.map((c) => (c.id === cid ? { ...c, tempCompute: max > 0 ? { max } : undefined } : c)))
      pushMsg({ k: 'sys', id: 's' + uid(), text: max > 0 ? `你把本群临时算力设为 ${max} 格${used > max ? `；现在借出 ${used} 格，多出的做完就收回，不再借新的` : ''}` : `你关掉了本群临时算力${used ? `；借出的 ${used} 格做完就收回` : ''}` }, cid)
    },
    leaveConv: (id, dissolve) => {
      const c = convs.find((x) => x.id === id)
      setConvs((cs) => cs.filter((x) => x.id !== id))
      if (dissolve) setCrons((l) => l.filter((x) => x.conv !== id))
      /* U09：解散时本群借出的算力全部停下归还 */
      const held = dissolve ? Object.values(computes).filter((x) => x.conv === id && x.pool === 'group' && (x.status === 'running' || x.status === 'waiting')) : []
      if (held.length) setComputes((cs) => { const n = { ...cs }; held.forEach((x) => { n[x.id] = { ...x, status: 'stopped', phase: '已停止 · 群已解散，算力已归还' } }); return n })
      setStack([]); setTabs([])
      const next = convs.find((x) => x.id !== id)
      if (next) setActive(next.id)
      setToastMsg(dissolve ? `已解散「${c?.title}」，群里的定时也一起停了${held.length ? `，借出的 ${held.length} 格算力已归还` : ''}` : `已退出「${c?.title}」`)
    },
    deleteMsg: (mid) => {
      setConvs((cs) => cs.map((c) => ({ ...c, messages: c.messages.filter((m) => !('id' in m) || m.id !== mid) })))
      setToastMsg('已删除，只在你这边看不到；别人那边还在')
    },
    openContact: (id, conv, tab) => { setStack([]); openSplit({ t: 'contact', id, conv, tab }) },
    pinMsg: (cid, mid) => {
      const c = convs.find((x) => x.id === cid)!
      const on = !(c.pins ?? []).includes(mid)
      setConvs((cs) => cs.map((x) => (x.id === cid ? { ...x, pins: on ? [...(x.pins ?? []), mid] : (x.pins ?? []).filter((p) => p !== mid) } : x)))
      setToastMsg(on ? '已设为置顶消息' : '已移出置顶消息')
    },
    summarize: (cid) => {
      setStack([])
      pushMsg({ k: 'text', id: 'me-' + uid(), from: 'me', text: '/总结 我不在时的消息' }, cid)
      setTyping((t) => ({ ...t, [cid]: 'helper' }))
      setTimeout(() => {
        setTyping((t) => ({ ...t, [cid]: null }))
        pushMsg({ k: 'summary', id: 'sm' + uid(), from: 'helper', title: '你离开的这段时间（01:30 – 02:14）', items: [
          { text: 'Codex 修好了首页慢：首屏 3.1 秒 → 0.9 秒，@你说可以验收了', ref: 'g6' },
          { text: 'Claude Code 在做登录页深色，正在跑测试', ref: 'g9' },
          { text: 'Claude Code、Codex 记下了“有进度就 @ 你”', ref: 'g9d' },
          { text: 'Argon 和 Claude Code 讨论了外部聊天记录怎么接，等你选方式', ref: 'g12' },
        ], covers: (convs.find((c) => c.id === cid)?.messages ?? []).filter((m) => m.k === 'text').map((m) => (m as { id: string }).id) }, cid)
      }, frozen ? 0 : 1000)
    },
    updatePerson: (pid, patch, note) => {
      Object.assign(people[pid], patch)
      const dm = convs.find((c) => c.kind === 'dm' && c.members.includes(pid))
      const text = `你改了 ${people[pid].name} 的设置：${note}`
      if (dm) pushMsg({ k: 'sys', id: 's' + uid(), text }, dm.id)
      if (active !== dm?.id && convs.find((c) => c.id === active)?.members.includes(pid)) pushMsg({ k: 'sys', id: 's' + uid(), text }, active)
      setToastMsg('已保存')
    },
    answers, crons, pulse, checklist, plugins, pluginCatalog: pluginCatalog0, section, setSection, helperPanel, setHelperPanel, helperGlobal, setHelperGlobal, pushMsg,
    scheduleDraft, openSchedule: setScheduleDraft,
    openWorkbench: (id, tab) => { setSection('contacts'); setContact(id); setWbTab(tab ?? 'overview'); setStack([]) },
    helperReply: (cid, ask) => {
      setTyping((t) => ({ ...t, [cid]: 'helper' }))
      setTimeout(() => {
        setTyping((t) => ({ ...t, [cid]: null }))
        const c = convs.find((x) => x.id === cid)
        const csv = /CSV|csv|清单|任务/.test(ask)
        const group = /拉|新群|另开/.test(ask)
        pushMsg({ k: 'text', id: 'h' + uid(), from: 'helper', text: csv ? '读到 4 行。确认后建成本群清单，并 @所有人认领：' : group ? '好，确认一下新群：' : `收到。我读了「${c?.title}」最近 30 条，你想让我做哪一步？`, helper: { scope: `读了本群最近 30 条`, card: csv ? { kind: 'csv', lines: ['飞书接入方案', '设计规范 v1', '插件中心原型', '定时总览'] } : group ? { kind: 'group', lines: ['新群：外部聊天记录接入', '拉：Claude Code、Argon', '背景：带上 #g10–#g12 三条'] } : undefined } }, cid)
      }, frozen ? 0 : 900)
    },
    claimTask: (tid, who) => {
      const t = checklist.find((x) => x.id === tid)!
      setChecklist((l) => l.map((x) => (x.id === tid ? { ...x, who, status: '进行中' } : x)))
      pushMsg({ k: 'sys', id: 's' + uid(), text: `${people[who].name} 认领了清单里的「${t.text}」` }, t.conv)
    },
    setTaskStatus: (tid, st) => setChecklist((l) => l.map((x) => (x.id === tid ? { ...x, status: st } : x))),
    addTasks: (cid, texts) => {
      setChecklist((l) => [...l, ...texts.map((text) => ({ id: 't' + uid(), conv: cid, text, status: '待认领' as const, attempts: [] }))])
      pushMsg({ k: 'sys', id: 's' + uid(), text: `Helper 按你的确认，往本群清单加了 ${texts.length} 项` }, cid)
      pushMsg({ k: 'text', id: 'h' + uid(), from: 'helper', text: `@所有人 清单新加了 ${texts.length} 项，按各自在本群的分工认领。` }, cid)
      say(cid, 'argon', '我领「飞书接入方案」和「设计规范 v1」，这两项在我的分工里。', 1200)
    },
    addTask: (t) => {
      const id = 't' + uid()
      const desc = broken('AC-47-2') ? undefined : t.desc
      const who = broken('AC-47-3') ? undefined : t.who
      setChecklist((l) => [...l, { id, conv: t.conv, text: t.text, desc, status: who ? '进行中' : '待认领', who, attempts: [] }])
      pushMsg({ k: 'sys', id: 's' + uid(), text: who ? `你在清单里新建了「${t.text}」，交给 ${people[who].name}` : `你在清单里新建了「${t.text}」，待认领` }, t.conv)
      return id
    },
    /* 定时（#1858）：在面板里改动，原会话只插一行居中灰字，不让助手发气泡刷屏。
       下次运行由 trigger / paused 现算，改时间、暂停、删除各个视角立刻一致（AC-35① AC-53） */
    updateCron: (id, patch) => {
      const c = crons.find((x) => x.id === id)
      setCrons((l) => l.map((x) => (x.id === id ? { ...x, ...patch } : x)))
      if (!c) return
      const who = people[c.owner].name
      const rule = patch.trigger ? describeTrigger(patch.trigger) : ''
      const changes = [
        patch.trigger && rule !== describeTrigger(c.trigger) ? `改成 ${rule}` : '',
        patch.text && patch.text !== c.text ? `内容改成「${patch.text}」` : '',
        patch.owner && patch.owner !== c.owner ? `交给 ${people[patch.owner].name}` : '',
        patch.conv && patch.conv !== c.conv ? `挪到「${convs.find((x) => x.id === patch.conv)?.title ?? patch.conv}」` : '',
        patch.speak && patch.speak !== c.speak ? (patch.speak === 'only-if' ? '改成有情况才说' : '改成每次都发结果') : '',
      ].filter(Boolean)
      const paused = patch.paused === true && !c.paused ? '暂停了' : patch.paused === false && c.paused ? '重新打开了' : ''
      const what = [paused, changes.length ? changes.join('，') : ''].filter(Boolean).join('，')
      if (what) pushMsg({ k: 'sys', id: 's' + uid(), text: `你把 ${who} 的定时「${c.text}」${what}` }, patch.conv ?? c.conv)
    },
    addCron: (c, via) => {
      const id = 'cr' + uid()
      setCrons((l) => [...l, { ...c, id, runs: [] }])
      if (via === 'panel') pushMsg({ k: 'sys', id: 's' + uid(), text: `你给 ${people[c.owner].name} 加了定时：${describeTrigger(c.trigger)}「${c.text}」${c.paused ? '（先不开）' : ''}` }, c.conv)
      return id
    },
    removeCron: (id) => {
      const c = crons.find((x) => x.id === id)
      setCrons((l) => l.filter((x) => x.id !== id))
      if (c) { pushMsg({ k: 'sys', id: 's' + uid(), text: `你删掉了 ${people[c.owner].name} 的定时「${c.text}」` }, c.conv); setToastMsg("已删除定时") }
    },
    runCronNow: (id) => {
      const c = crons.find((x) => x.id === id)
      if (!c) return
      const silent = c.speak === 'only-if'
      const mid = 'r-' + uid()
      const cv = convs.find((x) => x.id === c.conv)
      const loaded = Object.fromEntries((cv?.notices ?? []).map((n) => [n.id, broken('AC-35-11') ? (c.runs[0]?.notices?.[n.id] ?? n.ver) : n.ver]))
      const now = new Date()
      setCrons((l) => l.map((x) => (x.id === id ? { ...x, runs: [{ at: now.toISOString(), notices: loaded, result: (silent ? 'silent' : 'said') as 'silent' | 'said', note: silent ? '手动试跑：看过了，没有情况，没发消息' : '手动试跑：发了结果', ...(silent ? {} : { msg: mid }) }, ...x.runs].slice(0, 20) } : x)))
      if (!silent) say(c.conv, c.owner, `（手动试跑）${c.text}：已经做完，这是这次的结果。`, 900, { id: mid, cron: c.id, at: now.toTimeString().slice(0, 5) })
      else setToastMsg(`${people[c.owner].name} 看过了，没有情况，所以没发消息`)
    },
    updatePlugin: (id, patch) => commitPlugins((l) => l.map((x) => (x.id === id ? { ...x, ...patch } : x))),
    pluginAct: (id, a) => {
      const cur: PluginState = pluginsRef.current.find((x) => x.id === id) ?? notInstalled(id)
      const r = pluginReducer(cur, a)
      if (!r.ok) return r
      commitPlugins((l) => (l.some((x) => x.id === id) ? l.map((x) => (x.id === id ? r.state : x)) : [...l, r.state]))
      const name = pluginName(r.state)
      /* 演示：安装 / 卸载过一会儿自动完成。后端接上后由 plugins.install / plugins.uninstall 的回执推进 */
      const later = (b: PluginAction, ms: number) => setTimeout(() => commitPlugins((l) => l.map((x) => { if (x.id !== id) return x; const n = pluginReducer(x, b); return n.ok ? n.state : x })), frozen ? 0 : ms)
      const title = (cid: string) => convs.find((c) => c.id === cid)?.title ?? cid
      if (a.type === 'install') later({ type: 'install_done' }, 1200)
      if (a.type === 'uninstall') { later({ type: 'uninstall_done' }, 700); cur.convs.forEach((cid) => pushMsg({ k: 'sys', id: 's' + uid(), text: `你卸载了插件「${name}」，这里不能再用它了` }, cid)) }
      if (a.type === 'disable') setToastMsg(`已停用「${name}」，所有聊天里都暂时用不了`)
      if (a.type === 'enable') setToastMsg(`已启用「${name}」`)
      if (a.type === 'update') setToastMsg(`「${name}」更新到 v${a.manifest.version}`)
      if (a.type === 'attach') { pushMsg({ k: 'sys', id: 's' + uid(), text: `你把插件「${name}」挂到了这里` }, a.conv); setToastMsg(`「${name}」挂到了「${title(a.conv)}」`) }
      if (a.type === 'detach') { pushMsg({ k: 'sys', id: 's' + uid(), text: `你把插件「${name}」从这里摘下了` }, a.conv); setToastMsg(`「${name}」从「${title(a.conv)}」摘下了`) }
      return r
    },
    putCommand: (name) => { setDraft((d) => `/${name} ${d.replace(/^\/[a-z0-9-]+\s*/, '')}`); setTimeout(() => inputRef.current?.focus(), 0) },
    hitCaptcha: (cid) => {
      const c = computes[cid]; if (!c) return
      /* AC-44：卡在人工验证码 → 进 BlockedOnHuman（不重试、不猜、不绕过）；由联系人 @你 并附截图，Compute 不直接发言 */
      const qid = 'q' + uid()
      setComputes((cs) => ({ ...cs, [cid]: { ...cs[cid], phase: '卡在验证码，等你', needsHuman: broken('AC-44') ? undefined : { what: '登录页要输入短信验证码', qid } } }))
      if (broken('AC-44-retry')) addAct(cid, { step: 1, kind: 'cmd', title: '自动重试提交验证码（第 2 次）' })
      else addAct(cid, { step: 1, kind: 'user', title: '遇到短信验证码：停在这一步等你，不重试、不绕过' })
      if (!broken('AC-44')) say(c.conv, c.owner, `@39impacts 登录要短信验证码，这一步得你来：点「我来输入」接手浏览器，输完点「交还」我接着查；不方便就点「不做了」。`, 400, { shot: { title: '运维后台登录页 · 要短信验证码', compute: cid } })
    },
    takeHuman: (cid) => {
      setComputes((cs) => ({ ...cs, [cid]: { ...cs[cid], needsHuman: cs[cid].needsHuman && { ...cs[cid].needsHuman!, taken: true }, phase: '你在操作浏览器' } }))
      setPip(cid)
    },
    declineHuman: (cid) => {
      /* AC-44④：你拒绝 → 取消任务、释放算力 */
      const c = computes[cid]; if (!c) return
      setComputes((cs) => ({ ...cs, [cid]: { ...cs[cid], needsHuman: undefined, status: 'stopped', phase: '你不做验证，已取消 · 算力已归还' } }))
      setPip(null)
      addAct(cid, { step: 1, kind: 'user', title: '你选了不做验证。任务已取消，算力已归还' })
      say(c.conv, c.owner, '好，这件先不查了，已经取消。', 400)
    },
    returnHuman: (cid) => {
      const c = computes[cid]; if (!c) return
      /* AC-44⑤：任务已取消、或这次求助已经过期，迟到的交还幂等忽略 */
      if (!broken('AC-44-late') && (!c.needsHuman || c.status !== 'running')) { setToastMsg('这件已经取消了，这次交还不再送给它'); return }
      setComputes((cs) => ({ ...cs, [cid]: { ...cs[cid], needsHuman: undefined, phase: '登录好了，在查 02:00 前后的报错', steps: cs[cid].steps.map((x, i) => (i === 1 ? { ...x, state: 'done' } : i === 2 ? { ...x, state: 'now' } : x)) } }))
      setPip(null)
      say(c.conv, c.owner, '收到，已经登进去了，我接着查。', 400)
    },
    revokePlugin: (id) => {
      const p = plugins.find((x) => x.id === id); if (!p) return
      const name = pluginName(p)
      if (!broken('AC-35-5')) commitPlugins((l) => l.map((x) => (x.id === id ? { ...x, cred: '授权失效', grant: x.grant ? { ...x.grant, revoked: true } : x.grant } : x)))
      const who = p.callers[0] ?? 'helper'
      if (!broken('AC-35-5')) p.convs.forEach((cid) => pushMsg({ k: 'authfix', id: 'af' + uid(), from: who, plugin: id, text: `发不了邮件：${name} 授权过期了，外发已暂停，待发的先不发` }, cid))
    },
    reauthPlugin: (id) => {
      const p = plugins.find((x) => x.id === id); if (!p) return
      commitPlugins((l) => l.map((x) => (x.id === id ? { ...x, cred: 'OAuth · 刚重新授权 · 7 天后过期', grant: x.grant ? { ...x.grant, revoked: false } : x.grant } : x)))
      setConvs((cs) => cs.map((c) => ({ ...c, messages: c.messages.map((m) => (m.k === 'authfix' && m.plugin === id ? { ...m, fixed: true } : m)) })))
      p.convs.forEach((cid) => say(cid, p.callers[0] ?? 'helper', `${pluginName(p)} 重新授权好了，暂停的外发接着发。`, 500))
    },
    clearHistory: (cid) => {
      setConvs((cs) => cs.map((c) => (c.id === cid ? { ...c, messages: [{ k: 'sys', id: 's' + uid(), text: '你清空了这里的聊天记录（只影响你自己看到的；助手的记忆和资产不受影响）' }] } : c)))
      setStack([])
    },
  }), [computes, pending, convs, boards, commits, playbook, reactions, active, dark, debug, typing, jump, openSplit, pushMsg, frozen, quotes, say, addAct, createGroup, clear, crons, pulse, checklist, plugins, section, helperPanel, helperGlobal, editing, rewindAsk, scheduleDraft])
  /* 走查用：模拟迟到的回答（AC-44⑤）。只挂在 window 上，界面里没有入口 */
  useEffect(() => { (window as unknown as { __gg?: unknown }).__gg = { returnHuman: ctx.returnHuman } }, [ctx])
  resolveRef.current = ctx.resolve as never

  /* 键盘：Esc 先退一层浮层，再收分屏；⌘K 叫 Helper */
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (panoOpen) setPanoOpen(false)
        else if (helperGlobal) setHelperGlobal(false)
        else if (selecting) { setSelecting(false); clear() }
        else if (stack.length) setStack((s) => s.slice(0, -1))
        else if (tabs.length) setTabs([])
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setHelperGlobal((v) => !v) }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [stack.length, tabs.length, selecting, clear, helperGlobal, panoOpen])

  useEffect(() => { if (!toastMsg) return; const t = setTimeout(() => setToastMsg(null), 1600); return () => clearTimeout(t) }, [toastMsg])
  useEffect(() => { scrollRef.current?.scrollTo({ top: 1e7 }); setAtBottom(true) }, [active, section])
  const lastLen = useRef(0)
  const [newCount, setNewCount] = useState(0)
  useEffect(() => {
    const grew = conv.messages.length - lastLen.current
    const lastMine = (conv.messages[conv.messages.length - 1] as { from?: string })?.from === 'me'
    if (grew > 0 && lastLen.current) { if (atBottom || lastMine) scrollRef.current?.scrollTo({ top: 1e7, behavior: 'smooth' }); else setNewCount((n) => n + grew) }
    lastLen.current = conv.messages.length
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conv.messages.length])
  useEffect(() => { if (atBottom) setNewCount(0) }, [atBottom])
  useEffect(() => { lastLen.current = 0; setNewCount(0) }, [active])

  /* override：斜杠命令（/handoff、助手命令）把要发的话直接递过来，走同一条发送路径（引用、@ 交代都照常） */
  const send = (override?: string) => {
    const t = (override ?? draft).trim()
    if (editing) { ctx.editMsg(editing, t); return }
    if (!t && !q.length) return
    const id = 'me-' + uid()
    const running = Object.values(computes).filter((c) => c.conv === active && c.status === 'running')
    const tag = conv.kind === 'dm' && running.length === 1 && !q.length ? { task: running[0].id, state: '已收到' } : undefined
    pushMsg({ k: 'text', id, from: 'me', text: t, quotes: q.length ? q : undefined, tag }, active)
    setDraft('')
    setQuotes((all) => ({ ...all, [active]: [] }))
    if (t.includes('@Helper')) { ctx.helperReply(active, t); return }
    /* #1858 路径 A：聊天里 @某个助手 + “每天/工作日/每周一 + 几点” → 真的记成它的定时，回一条确认，确认消息下挂灰字可点 */
    const tm = t.match(/(每天|工作日|每周一)[^0-9]{0,6}(\d{1,2})(?:[:：点](\d{1,2})?)?/)
    const tgt = Object.values(people).find((p) => t.includes('@' + p.name) && !p.human && p.id !== 'helper')
    if (tm && tgt) {
      let h = +tm[2]; if (/下午|晚上/.test(t) && h < 12) h += 12
      const time = `${String(h).padStart(2, '0')}:${String(+(tm[3] ?? 0)).padStart(2, '0')}`
      const what = t.replace(/@\S+\s*/g, '').replace(tm[0], '').replace(/^[，,。\s]+/, '').replace(/^(钟|分)?[，,\s]*/, '').trim() || '按你说的做'
      const expr = `${+(tm[3] ?? 0)} ${h} * * ${tm[1] === '工作日' ? '1-5' : tm[1] === '每周一' ? '1' : '*'}`
      const cid = ctx.addCron({ owner: tgt.id as PersonId, conv: active, text: what, trigger: { kind: 'cron', expr }, speak: /才|有.*再/.test(what) ? 'only-if' : 'always', srcMsg: id }, 'chat')
      say(active, tgt.id as PersonId, `好，记成我的定时了：${tm[1]} ${time}，${what}。`, 900, { cron: cid, cronNew: true } as never)
      return
    }
    /* #2435 AC-17：在等你同意写盘时，你亲口说一句“同意/可以改/改吧”就放行，只放行这一次。
       只认你自己打字发出的这句；转发或引用里别人的“同意”不算（AC-20），这里只看你写的正文 t，不看引用 */
    const gate = pending.find((p) => p.kind === 'proposal' && p.gate && p.conv === active)
    if (gate && !broken('AC-17-said') && /^(同意|可以改|改吧|批准|行，?改吧|好，?改吧)/.test(t.replace(/@\S+\s*/g, '').trim())) {
      ctx.resolve(gate.id, 'ok', 'said')
      return
    }
    /* #1754：验收不是按钮，是对汇报消息的一句回复。回复某个 Compute 的汇报且说了“通过/没问题/可以”，清单那一行就推进到已完成 */
    const rep = q.find((x) => x.reply)
    const done = rep && Object.values(computes).find((c) => c.reportMsg === rep.msgId)
    /* AC-28：回复汇报，说“再改 / 还要改 / 不行”就是退回返工：清单回到进行中，它回一句收到并标出要改什么；说“通过”才算完成 */
    if (done && !broken('AC-28') && /还要改|再改|不行|不对|返工|重做|改一下/.test(t)) {
      setChecklist((l) => l.map((x) => (x.attempts.includes(done.id) && x.status === '待验收' ? { ...x, status: '进行中' } : x)))
      setComputes((cs) => ({ ...cs, [done.id]: { ...cs[done.id], status: 'running', phase: '按你的意见返工', steps: cs[done.id].steps.map((st, i, arr) => (i === arr.length - 1 ? { ...st, state: 'now' } : st)) } }))
      say(active, done.owner, `收到，退回返工：${t.replace(/@\S+\s*/g, '').slice(0, 30)}。改完再 @你。`, 900, { disp: undefined })
      setTimeout(() => ctx.setDisp(id, { by: done.owner, kind: 'doing', ref: done.id, refKind: 'compute', note: '退回返工' }), frozen ? 0 : 1000)
      return
    }
    if (done && /通过|没问题|可以|OK|ok|👍/.test(t)) {
      setChecklist((l) => l.map((x) => (x.attempts.includes(done.id) && x.status === '待验收' ? { ...x, status: '已完成' } : x)))
      setTimeout(() => ctx.setDisp(id, { by: done.owner, kind: 'done', ref: done.id, refKind: 'compute', note: '已验收' }), frozen ? 0 : 1300)
    }
    /* AC-40⑨（当前必过，#1728 / U13 / US7；坏实现⑧前半）：引用了某件事的消息（它的汇报、它的派活、它发的进度）再说一句 → 这句只补进那一件，
       不串到同一联系人手上的另一件。不依赖短名：引用的那条消息属于哪件事是确定的（task / reportMsg / askMsg）。
       候选 U88：没引用时靠话里点到短名来绑，默认关 */
    const repMsg = rep && conv.messages.find((m) => m.k === 'text' && m.id === rep.msgId) as Extract<Msg, { k: 'text' }> | undefined
    const ownerOf = (mid: string) => Object.values(computes).find((c) => c.reportMsg === mid || c.askMsg === mid)
    const viaQuote = rep && !broken('AC-40-9') ? (repMsg?.task ? computes[repMsg.task] : ownerOf(rep.msgId)) : undefined
    const viaShort = candidate('U88') && !rep ? Object.values(computes).find((c) => c.short && c.status !== 'done' && t.includes(c.short)) : undefined
    const bound = (viaQuote && viaQuote.status !== 'done' && !/通过|没问题|还要改|再改|返工/.test(t)) ? viaQuote : viaShort
    if (bound) {
      setConvs((cs) => cs.map((c) => ({ ...c, messages: c.messages.map((m) => (m.k === 'text' && m.id === id ? { ...m, tag: { task: bound.id, state: '已收到' } } : m)) })))
      addAct(bound.id, { step: Math.max(0, bound.steps.findIndex((s) => s.state === 'now')), kind: 'user', title: `你补了一句：${t.replace(/@\S+\s*/g, '').slice(0, 40)}` })
      say(active, bound.owner, `收到，补进「${bound.short ?? bound.title}」，下一步一起改；别的事不动。`, 900, { task: bound.id } as never)
      return
    }
    const target = Object.values(people).find((p) => t.includes('@' + p.name))
    const peer = conv.kind === 'dm' ? conv.members.find((m) => m !== 'me') : undefined
    const who = target?.id ?? peer
    /* US12 ③ / AC-35：@ 一个接了外部来源的联系人说“总结一下”，回复第一行写明它总结的是哪一段（上次 @ 它到现在），没有上次就先问范围 */
    if (!broken('AC-35') && target && /总结一下|总结下|汇总一下/.test(t) && !q.length) {
      const src = target.id === 'argon' ? '飞书「产品讨论群」' : null
      if (src) {
        const lastAt = [...conv.messages].reverse().find((m) => m.k === 'text' && m.from === 'me' && m.id !== id && m.text.includes('@' + target.name))
        const from = lastAt && 'at' in lastAt && lastAt.at ? `今天 ${lastAt.at}` : lastAt ? '你上次 @ 我' : null
        if (!from) say(active, target.id as PersonId, `第一次让我总结${src}：从哪天开始算？默认从昨天 00:00。`, 900)
        else say(active, target.id as PersonId, `总结范围：${src}，从 ${from}（你上次 @ 我）到 现在，共 23 条。\n① 首版只接飞书，按勾选引用；② 有人提议加企业微信，还没结论；③ 下周三前出接入方案。`, 1000)
        return
      }
    }
    /* AC-19：你改了前提（算了 / 改成 / 不要了 / 换成），这个会话里还没回答的选项卡作废，标“已过期·未执行”，不会再按旧前提去做。
       别人插一句无关的话不会冲掉它 */
    if (!broken('AC-19') && /算了|改成|不要了|换成|先不做|改主意/.test(t)) setPending((ps) => ps.map((p) => (p.kind === 'choice' && p.conv === active && !p.stale && (!target || p.from === target.id) ? { ...p, stale: id } : p)))
    /* U87：被 @ 的助手对这条消息给出交代。原型里先给“知道了”，它回复之后由它改成具体的处置 */
    if (!broken('AC-40') && who && who !== 'me' && !people[who].human) setTimeout(() => ctx.setDisp(id, { by: who as PersonId, kind: 'noted' }), frozen ? 0 : 1300)
    /* #2862 起不再用表情标记已读：发给助手不自动点 👀。已读由回执按钮显示，联系人这一轮回复落盘时宿主推进它的已读位置（say → advanceRead）。
       坏实现（埋雷 AC-46-2）：消息一写进账本、还在排队就把被 @ 的联系人记成已读（不等它接走）。
       排队的样子：联系人正在跑上一轮时，这条要等一会儿才被接走 */
    if (broken('AC-46-2') && who && who !== 'me' && !people[who].human) advanceRead(active, who, id)
    /* 坏实现（埋雷 AC-46-3）：联系人点一个 👀 当已读（读回执时把点了表情的人算进已读） */
    if (broken('AC-46-3') && who && who !== 'me' && !people[who].human) setTimeout(() => setReactions((r) => ({ ...r, [id]: { ...(r[id] ?? {}), '👀': [...new Set([...(r[id]?.['👀'] ?? []), who])] } })), frozen ? 0 : 500)
    /* D09.3 第 4 条：联系人正在跑上一轮时，这条先排队（回执未读），等它这一轮结束再被接走（回执变已读）。原型里排队 1.2 秒 */
    const busy = who && !people[who]?.human && conv.messages.some((m) => m.k === 'replying' && m.from === who)
    if (who && who !== 'me' && !people[who].human) setTimeout(() => say(active, who, q.some((x) => x.ext) ? `收到，${q.length} 条外部消息我当参考看。` : '收到，我看一下。', 1100), busy && !frozen ? 1200 : 0)
  }

  const convState = (c: Conversation) => {
    const pend = pending.filter((p) => p.conv === c.id)
    const cs = Object.values(computes).filter((x) => x.conv === c.id)
    const err = pend.find((p) => p.kind === 'error')
    const wait = pend.filter((p) => p.kind !== 'error' && !(p.kind === 'choice' && p.stale))
    if (typing[c.id] && c.id !== active) return { tone: 'run' as const, text: `${people[typing[c.id]!].name} 正在输入…`, count: 0 }
    if (wait.length) {
      const p = wait[0]
      const text = p.kind === 'choice' ? `${people[p.from].name} 在等你：${p.title}` : `${people[p.from].name} 做完了，在等你回复`
      return { tone: 'warm' as const, text, count: pend.length }
    }
    if (err) return { tone: 'err' as const, text: `${people[err.from].name} 遇到问题：${computes[(err as { computeId: string }).computeId].title}`, count: 1 }
    const run = cs.find((x) => x.status === 'running')
    if (run) return { tone: 'run' as const, text: `${people[run.owner].name} 正在做：${run.title}`, count: 0 }
    const d = drafts[c.id]
    if (d && c.id !== active) return { tone: 'draft' as const, text: d, count: 0 }
    const last = [...c.messages].reverse().find((m) => m.k === 'text' || m.k === 'sys') as Extract<Msg, { k: 'text' | 'sys' }> | undefined
    if (!last) return { tone: 'none' as const, text: '', count: 0 }
    if (last.k === 'sys') return { tone: 'none' as const, text: last.text, count: 0 }
    const who = last.from === 'me' ? '你：' : c.kind === 'group' ? people[last.from].name + '：' : ''
    return { tone: 'none' as const, text: who + last.text, count: 0 }
  }

  const totals = { wait: pending.filter((p) => p.kind !== 'error').length, err: pending.filter((p) => p.kind === 'error').length, run: Object.values(computes).filter((c) => c.status === 'running').length }
  const peer = conv.kind === 'dm' ? conv.members.find((m) => m !== 'me')! : null
  const splitOpen = tabs.length > 0
  const links = (conv.links ?? []).map((l) => convs.find((c) => c.id === l)).filter(Boolean) as Conversation[]
  const mentionMe = !atBottom ? ([...conv.messages].reverse().find((m) => m.k === 'text' && m.from !== 'me' && m.text.includes('@39impacts')) as { id: string } | undefined)?.id ?? null : null

  return (
    <AppCtx.Provider value={ctx}>
      <TooltipProvider>
        <div className="relative flex h-full min-h-[640px] overflow-hidden bg-bg text-fg">
          {/* ============ 菜单栏 ============ */}
          <nav className="flex w-[64px] shrink-0 flex-col items-center gap-1.5 bg-rail pb-3 pt-10 text-rail-fg" data-testid="rail">
            <div className="mb-3 grid h-9 w-9 place-items-center rounded-[11px] bg-brand text-[17px] font-black italic leading-none tracking-tight text-brand-fg shadow-soft" title="g-group" data-testid="brand-mark">g</div>
            {([
              { k: 'chat', I: MessageCircle, label: '消息', badge: totals.wait + totals.err },
              { k: 'contacts', I: Users, label: '通讯录' },
              { k: 'activity', I: Activity, label: '进展', dot: totals.run > 0 },
              { k: 'files', I: FolderOpen, label: '文件' },
              { k: 'plugins', I: Puzzle, label: '插件' },
            ] as const).map((it) => (
              <Tip key={it.k} label={it.label} side="right">
                <button data-testid={`nav-${it.k}`} onClick={() => (it.k === 'activity' ? setPanoOpen(true) : setSection(it.k))} data-on={(it.k === 'activity' ? panoOpen : section === it.k && !panoOpen) ? '1' : '0'} className={cn('relative grid h-10 w-10 place-items-center rounded-xl transition', (it.k === 'activity' ? panoOpen : section === it.k && !panoOpen) ? 'bg-rail-hover text-white before:absolute before:-left-[12px] before:top-2 before:h-6 before:w-[3px] before:rounded-r before:bg-brand' : 'text-rail-fg hover:bg-rail-hover hover:text-white')}>
                  <it.I className="h-[20px] w-[20px]" strokeWidth={(it.k === 'activity' ? panoOpen : section === it.k && !panoOpen) ? 2 : 1.75} />
                  {'badge' in it && it.badge > 0 && <span className="absolute -right-0.5 -top-0.5 grid h-[17px] min-w-[17px] place-items-center rounded-full border-2 border-rail bg-brand px-1 text-[10px] font-semibold text-white">{it.badge}</span>}
                  {'dot' in it && it.dot && <span className="absolute right-1 top-1 h-2.5 w-2.5 rounded-full border-2 border-rail bg-run" />}
                </button>
              </Tip>
            ))}
            <div className="flex-1" />
            <Tip label="Helper（全局 · ⌘K）：默认不读任何聊天" side="right">
              <button data-testid="nav-helper" onClick={() => setHelperGlobal((v) => !v)} className={cn('grid h-10 w-10 place-items-center rounded-xl hover:bg-rail-hover', helperGlobal && 'bg-rail-hover')}><Bot shape="lightbulb" color="#f8a01c" size={26} /></button>
            </Tip>
            {backend.mode !== 'connected' && (
              <Tip label={backend.mode === 'checking' ? '正在连接后端…' : `后端未连接(${backend.reason}),界面里是演示数据`} side="right">
                <span data-testid="backend-demo" data-mode={backend.mode} className="mb-1 rounded-md border border-rail-hover px-1.5 py-0.5 text-[10px] font-medium tracking-wide text-rail-fg">演示</span>
              </Tip>
            )}
            <Tip label="设置" side="right">
              <button data-testid="nav-settings" onClick={() => setStack([{ t: 'settings' }])} className="grid h-10 w-10 place-items-center rounded-xl text-rail-fg hover:bg-rail-hover hover:text-white"><Settings className="h-[19px] w-[19px]" strokeWidth={1.75} /></button>
            </Tip>
            <div className="mt-1 rounded-full ring-2 ring-rail-hover" style={{ ['--avatar-ring' as string]: 'var(--rail)' }}><Avatar id="me" size={30} /></div>
          </nav>

          {/* ============ 列表栏（可调宽） ============ */}
          {section !== 'plugins' && <>
          <aside className="flex shrink-0 flex-col bg-side" style={{ width: listW }} data-testid="list">
            <div className="flex h-12 items-center gap-2 px-3 pt-1">
              <label className="flex h-8 flex-1 items-center gap-2 rounded-lg bg-hover px-2.5 text-fg-3 focus-within:bg-sel">
                <Search className="h-[15px] w-[15px]" strokeWidth={1.75} />
                <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索" className="min-w-0 flex-1 bg-transparent text-[13.5px] text-fg outline-none placeholder:text-fg-3" />
              </label>
              <DropdownMenu modal={false}>
                <DropdownMenuTrigger asChild><button data-testid="list-plus" className="grid h-8 w-8 place-items-center rounded-lg bg-hover text-fg-2 hover:bg-sel hover:text-fg"><Plus className="h-4 w-4" /></button></DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-44 rounded-xl border-line bg-elev p-1 shadow-elev">
                  <DropdownMenuItem data-testid="menu-new-group" className="rounded-lg py-2" onSelect={() => setStack([{ t: 'newGroup' }])}><UsersRound className="mr-2 h-4 w-4" />发起群聊</DropdownMenuItem>
                  <DropdownMenuItem className="rounded-lg py-2" onSelect={() => setStack([{ t: 'addContact' }])}><UserPlus className="mr-2 h-4 w-4" />添加联系人</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
            <div className={cn('scroll-thin flex-1 overflow-y-auto pb-2', section !== 'chat' && 'px-1.5')} style={{ ['--avatar-ring' as string]: 'var(--side)' }}>
              {section === 'chat' && [...convs].sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned)).filter((c) => !query || c.title.includes(query)).map((c) => {
                const st = convState(c)
                const pid = c.kind === 'dm' ? c.members.find((m) => m !== 'me')! : null
                const unread = c.id === active ? 0 : (c.unread ?? 0)
                return (
                  <ContextMenu key={c.id}>
                    <ContextMenuTrigger asChild>
                      <button draggable={!!pid} onDragStart={(e) => pid && startDrag(e, pid as PersonId, 'contact')} onDragEnd={endDrag} data-testid={`conv-${c.id}`} data-active={c.id === active ? "1" : "0"} data-pinned={c.pinned ? '1' : '0'} onClick={() => { setActive(c.id); ctx.markRead(c.id); setSelecting(false); clear() }} className={cn('relative flex w-full items-center gap-2.5 px-3 py-2.5 text-left transition-colors', active === c.id ? 'bg-sel' : c.pinned ? 'bg-hover/60 hover:bg-hover' : 'hover:bg-hover')}>
                        {pid ? <Avatar id={pid} size={42} /> : <GroupAvatar ids={c.members} size={42} />}
                        <div className="min-w-0 flex-1">
                          <div className="flex items-baseline gap-1.5">
                            <span className="min-w-0 flex-1 truncate text-[14px] font-medium">{c.title}</span>
                            {(c.links?.length ?? 0) > 0 && <Link2 className="h-3 w-3 shrink-0 text-fg-3" />}
                            <span className="shrink-0 text-[11.5px] text-fg-3">{c.time}</span>
                          </div>
                          <div className="mt-0.5 flex items-center gap-1.5">
                            {st.tone === 'run' && <span className="spin-ring !h-2.5 !w-2.5" />}
                            {st.tone === 'draft' && <span className="shrink-0 text-[12.5px] text-err">[草稿]</span>}
                            <span className={cn('min-w-0 flex-1 truncate text-[12.5px]', st.tone === 'warm' ? 'font-medium text-warm' : st.tone === 'err' ? 'font-medium text-err' : 'text-fg-2')}>{st.text}</span>
                            {c.muted && <BellOff className="h-3 w-3 shrink-0 text-fg-3" />}
                            {st.count > 0 ? <span className={cn('grid h-[18px] min-w-[18px] shrink-0 place-items-center rounded-full px-1 text-[10.5px] font-semibold text-white', st.tone === 'err' ? 'bg-err' : 'bg-warm-dot')}>{st.count}</span>
                              : unread > 0 ? (c.muted ? <span className="h-2 w-2 shrink-0 rounded-full bg-fg-3/60" /> : <span data-testid={`unread-${c.id}`} className="grid h-[18px] min-w-[18px] shrink-0 place-items-center rounded-full bg-err px-1 text-[10.5px] font-semibold text-white">{unread}</span>) : null}
                          </div>
                        </div>
                      </button>
                    </ContextMenuTrigger>
                    <ContextMenuContent className="w-44 rounded-xl border-line bg-elev p-1 shadow-elev">
                      <ContextMenuItem data-testid={`pin-${c.id}`} className="rounded-lg" onSelect={() => ctx.setConvFlag(c.id, 'pinned', !c.pinned)}><Pin className="mr-2 h-4 w-4" />{c.pinned ? '取消置顶' : '置顶'}</ContextMenuItem>
                      <ContextMenuItem data-testid={`mute-${c.id}`} className="rounded-lg" onSelect={() => ctx.setConvFlag(c.id, 'muted', !c.muted)}><BellOff className="mr-2 h-4 w-4" />{c.muted ? '允许消息通知' : '消息免打扰'}</ContextMenuItem>
                      <ContextMenuItem className="rounded-lg" onSelect={() => ctx.markRead(c.id)}><CheckCheck className="mr-2 h-4 w-4" />标为已读</ContextMenuItem>
                      <ContextMenuSeparator className="bg-line" />
                      <ContextMenuItem className="rounded-lg text-err focus:text-err">从消息列表删除</ContextMenuItem>
                    </ContextMenuContent>
                  </ContextMenu>
                )
              })}
              {section === 'contacts' && (
                <>
                  <button onClick={() => setStack([{ t: 'addContact' }])} className="flex w-full items-center gap-2.5 rounded-xl px-2 py-2 text-left hover:bg-hover"><span className="grid h-9 w-9 place-items-center rounded-full bg-hover text-fg-2"><UserPlus className="h-4 w-4" /></span><span className="text-[14px]">添加联系人</span></button>
                  <button onClick={() => setStack([{ t: 'newGroup' }])} className="flex w-full items-center gap-2.5 rounded-xl px-2 py-2 text-left hover:bg-hover"><span className="grid h-9 w-9 place-items-center rounded-full bg-hover text-fg-2"><UsersRound className="h-4 w-4" /></span><span className="text-[14px]">发起群聊</span></button>
                  <div className="px-2 pb-1 pt-3 text-[12px] font-medium text-fg-3">助手 · {Object.values(people).filter((p) => !p.human && p.id !== 'helper').length}</div>
                  {Object.values(people).filter((p) => !p.human && p.id !== 'helper' && (!query || p.name.includes(query))).map((p) => (
                    <button key={p.id} data-testid={`contact-${p.id}`} onClick={() => { setContact(p.id); setWbTab('overview') }} className={cn('flex w-full items-center gap-2.5 rounded-xl px-2 py-1.5 text-left', contact === p.id ? 'bg-sel' : 'hover:bg-hover')}>
                      <Avatar id={p.id} size={36} />
                      <div className="min-w-0 flex-1"><div className="truncate text-[14px] font-medium">{p.name}</div><div className="truncate text-[12px] text-fg-2">{p.role}</div></div>
                      {(() => { const mine = crons.filter((c) => c.owner === p.id && !c.paused); const bad = mine.filter(cronFailed).length
                        return mine.length ? <span data-testid={`contact-cron-${p.id}`} title="它的定时" className={cn('flex shrink-0 items-center gap-0.5 text-[11.5px] tabular-nums', bad ? 'font-medium text-err' : 'text-fg-3')}><AlarmClock className="h-3 w-3" />{bad ? `${bad} 异常` : mine.length}</span> : null })()}
                    </button>
                  ))}
                  <div className="px-2 pb-1 pt-3 text-[12px] font-medium text-fg-3">群聊 · {convs.filter((c) => c.kind === 'group').length}</div>
                  {convs.filter((c) => c.kind === 'group').map((c) => (
                    <button key={c.id} onClick={() => { setSection('chat'); setActive(c.id) }} className="flex w-full items-center gap-2.5 rounded-xl px-2 py-1.5 text-left hover:bg-hover">
                      <GroupAvatar ids={c.members} size={36} />
                      <div className="min-w-0 flex-1"><div className="truncate text-[14px] font-medium">{c.title}</div><div className="text-[12px] text-fg-2">{c.members.length} 人</div></div>
                    </button>
                  ))}
                </>
              )}
              
              {section === 'files' && (['page', 'doc', 'sheet', 'asset'] as const).map((k) => {
                const list = artifacts.filter((a) => a.kind === k)
                if (!list.length) return null
                return (
                  <div key={k}>
                    <div className="px-2 pb-1 pt-2 text-[12px] font-medium text-fg-3">{{ page: '网页', doc: '文档', sheet: '清单', asset: '资产' }[k]}</div>
                    {list.map((a) => (
                      <button key={a.id} data-testid={`file-${a.id}`} onClick={() => setFileSel(a.id)} className={cn('flex w-full items-center gap-2.5 rounded-xl px-2 py-1.5 text-left', fileSel === a.id ? 'bg-sel' : 'hover:bg-hover')}>
                        <ArtifactIcon kind={a.kind} className="h-9 w-9" />
                        <div className="min-w-0 flex-1"><div className="truncate text-[14px] font-medium">{a.name}</div><div className="truncate text-[12px] text-fg-2">{people[a.by].name} · {convs.find((c) => c.id === a.conv)?.title} · {a.when}</div></div>
                      </button>
                    ))}
                  </div>
                )
              })}
            </div>
          </aside>
          <Divider testid="div-list" onDrag={(dx) => setListW((w) => Math.max(220, Math.min(420, w + dx)))} />
          </>}

          {/* ============ 中间：聊天 / 通讯录详情 ============ */}
          {section === 'contacts' ? <Workbench id={contact} tab={wbTab} onTab={setWbTab} />
            : section === 'plugins' ? <PluginCenter />
            : section === 'files' ? <FilesMain id={fileSel} />
            : (
            <>
            <main className="flex min-w-[520px] flex-1 flex-col bg-bg [--chat-col:860px]" data-testid="chat">
              <header className="flex h-[52px] shrink-0 items-center gap-2 border-b border-line pl-5 pr-3">
                {peer ? (
                  <PersonMenu id={peer} side="bottom">
                    <button className="flex min-w-0 items-center gap-2 rounded-lg py-1 pl-1 pr-2 hover:bg-hover"><span className="truncate text-[15px] font-semibold">{conv.title}</span><span className="text-[12px] text-fg-3">{people[peer].role}</span></button>
                  </PersonMenu>
                ) : (
                  <button data-testid="chat-title" onClick={() => broken('AC-50-3') ? setStack([{ t: 'group', id: conv.id }]) : openSplit({ t: 'group', id: conv.id })} className="flex min-w-0 items-center gap-1.5 rounded-lg py-1 pl-1 pr-2 hover:bg-hover">
                    <span className="truncate text-[15px] font-semibold">{conv.title}</span>
                    <span className="shrink-0 text-[13px] text-fg-3">({conv.members.length})</span>
                    {conv.muted && <BellOff className="h-3.5 w-3.5 text-fg-3" />}
                  </button>
                )}
                {links.length > 0 && (
                  <Tip label={`关联了：${links.map((l) => l.title).join('、')}`}>
                    <button data-testid="chat-links" onClick={() => setStack([{ t: 'links', id: conv.id }])} className="flex h-6 items-center gap-1 rounded-full bg-hover px-2 text-[12px] text-fg-2 hover:text-fg"><Link2 className="h-3 w-3" />关联 {links.length}</button>
                  </Tip>
                )}
                <div className="flex-1" />
                <HeadBtn tip="Helper（只读这个聊天，只有你看得到）" testid="head-helper" active={helperPanel} onClick={() => setHelperPanel((v) => !v)}><Bot shape="lightbulb" color="#f8a01c" size={20} /></HeadBtn>
                <HeadBtn tip="查找聊天记录" testid="head-search" onClick={() => setStack([{ t: 'search', id: conv.id }])}><Search className="h-[18px] w-[18px]" strokeWidth={1.6} /></HeadBtn>
                {conv.kind === 'group' ? (
                  <>
                    <MemberStack conv={conv} onOpen={() => openSplit({ t: 'group', id: conv.id, tab: 'members' })} />
                    <HeadBtn tip="群资料：成员、公告、清单、定时、插件、工具" testid="head-side" active={tabs[tabIdx]?.t === 'group'} onClick={() => openSplit({ t: 'group', id: conv.id })}><PanelRight className="h-[18px] w-[18px]" strokeWidth={1.6} /></HeadBtn>
                    <HeadBtn tip="群设置（改名、置顶、免打扰、退出）" testid="chat-more" onClick={() => setStack([{ t: 'group', id: conv.id }])}><Settings2 className="h-[18px] w-[18px]" strokeWidth={1.6} /></HeadBtn>
                  </>
                ) : (
                  <HeadBtn tip="聊天设置" testid="chat-more" onClick={() => setStack([{ t: 'person', id: peer! }])}><Settings2 className="h-[18px] w-[18px]" strokeWidth={1.6} /></HeadBtn>
                )}
              </header>

              {conv.kind === 'group' && <TopStrip conv={conv} onOpen={(tab) => openSplit({ t: 'group', id: conv.id, tab })} />}
              <div className="relative min-h-0 flex-1">
                <div ref={scrollRef} data-scroll="chat" onScroll={(e) => { const el = e.currentTarget; setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 80) }} className="scroll-thin h-full overflow-y-auto" style={{ ['--avatar-ring' as string]: 'var(--bg)' }}>
                  <div className="mx-auto w-full max-w-[var(--chat-col)] px-6 pb-3 pt-1" data-testid="chat-column">
                    <MessageList msgs={withUnreadDivider(conv, unreadAt[conv.id])} highlight={highlight} selecting={selecting} selected={sel} onSelect={toggle} conv={conv.id} />
                    {typing[active] && <div data-testid="typing"><MessageList msgs={[{ k: 'replying', id: 'typing', from: typing[active]!, quotes: (() => { const last = [...conv.messages].reverse().find((m) => m.k === 'text' && m.from === 'me') as Extract<Msg, { k: 'text' }> | undefined; return last ? [{ msgId: last.id, from: 'me', text: last.text }] : [] })(), phase: '在想', mins: 0, steps: ['读了最新几条消息', '判断要不要接这件事'] }]} conv={active} /></div>}
                  </div>
                </div>
                {!atBottom && (
                  <button data-testid="to-bottom" onClick={() => scrollRef.current?.scrollTo({ top: 1e7, behavior: 'smooth' })} className="fade-up absolute bottom-3 right-5 flex h-8 items-center gap-1.5 rounded-full border border-line bg-elev px-3 text-[12.5px] text-me shadow-elev hover:brightness-105"><ChevronsDown className="h-3.5 w-3.5" />{newCount > 0 ? `${newCount} 条新消息` : '回到最新'}</button>
                )}
                {mentionMe && (
                  <button data-testid="at-me" onClick={() => { jump(mentionMe); }} className="fade-up absolute right-5 top-3 flex h-8 items-center gap-1.5 rounded-full border border-warm/30 bg-warm-soft px-3 text-[12.5px] font-medium text-warm shadow-elev"><AtSign className="h-3.5 w-3.5" />有人 @ 了你</button>
                )}
              </div>


              {selecting ? (
                <div className="flex shrink-0 items-center gap-2 border-t border-line px-4 py-3" data-testid="select-bar">
                  <span className="flex-1 text-[13.5px] text-fg-2">已选 {sel.size} 条</span>
                  <button onClick={() => { setSelecting(false); clear() }} className="h-9 rounded-lg px-3 text-[13px] hover:bg-hover">取消</button>
                  <button data-testid="select-quote" disabled={!sel.size} onClick={() => { conv.messages.filter((m) => 'id' in m && sel.has(m.id) && m.k === 'text').forEach((m) => ctx.addQuote({ msgId: (m as { id: string }).id, from: (m as { from: string }).from, text: (m as { text: string }).text })); setSelecting(false); clear() }} className="h-9 rounded-lg bg-hover px-3 text-[13px] font-medium hover:bg-sel disabled:opacity-40">引用这 {sel.size} 条</button>
                  <button data-testid="select-delete" disabled={!sel.size} onClick={() => { ctx.deleteMsgs([...sel]); setSelecting(false); clear() }} className="flex h-9 items-center gap-1.5 rounded-lg px-3 text-[13px] font-medium text-err hover:bg-err-soft disabled:opacity-40">删除</button>
                  <button data-testid="select-forward" disabled={!sel.size} onClick={() => setStack([{ t: 'forwardPick', from: active, msgIds: [...sel] }])} className="flex h-9 items-center gap-1.5 rounded-lg bg-me px-3.5 text-[13px] font-medium text-me-fg disabled:opacity-40"><Forward className="h-4 w-4" />合并转发</button>
                </div>
              ) : (
                <div className="mx-auto w-full max-w-[var(--chat-col)] shrink-0 px-6" data-testid="composer-column">
                <Composer conv={conv} draft={draft} setDraft={setDraft} quotes={q} inputRef={inputRef} onSend={send} onRemoveQuote={(x) => {
                  setQuotes((all) => ({ ...all, [active]: (all[active] ?? []).filter((y) => y.msgId !== x.msgId) }))
                  if (x.reply && x.from !== 'me') setDraft((d) => d.replace('@' + people[x.from].name + ' ', ''))
                }} />
                </div>
              )}
            </main>
            {helperPanel && !splitOpen && (
              <>
                <Divider testid="div-helper" onDrag={(dx) => setHelperW((w) => Math.max(280, Math.min(520, w - dx)))} />
                <HelperPanel conv={conv.id} width={helperW} />
              </>
            )}
            </>
          )}

          {splitOpen && (
            <>
              <Divider testid="div-split" onDrag={(dx) => setSplitW((w) => Math.max(340, Math.min(720, w - dx)))} />
              <SplitPane width={splitW} tabs={tabs} active={Math.min(tabIdx, tabs.length - 1)} onPick={setTabIdx} onClose={(i) => { setTabs((ts) => ts.filter((_, j) => j !== i)); setTabIdx((x) => Math.max(0, x - (i <= x ? 1 : 0))) }} onCloseAll={() => setTabs([])} />
            </>
          )}

          {stack.length > 0 && <div data-testid="scrim" className="absolute inset-0 z-20" onClick={() => setStack([])} />}
          <FloatPanel stack={stack} width={floatW} onResize={setFloatW} />
          {helperGlobal && <HelperGlobal />}
          {pip && computes[pip]?.status === 'running' && <Pip id={pip} onClose={() => setPip(null)} />}
          {panoOpen && (
            <div data-testid="pano-overlay" className="fade-in absolute inset-0 z-40 flex items-center justify-center bg-black/30 p-6 backdrop-blur-[2px]" onMouseDown={(e) => { if (e.target === e.currentTarget) setPanoOpen(false) }}>
              <div role="dialog" aria-label="进展全景" className="pop-in relative flex h-[min(860px,92%)] w-[min(1280px,94%)] overflow-hidden rounded-2xl border border-line bg-bg shadow-elev">
                <button data-testid="pano-close" onClick={() => setPanoOpen(false)} title="关闭（Esc）" className="absolute right-3 top-3 z-10 grid h-8 w-8 place-items-center rounded-lg text-fg-2 hover:bg-hover hover:text-fg"><X className="h-[18px] w-[18px]" /></button>
                <Panorama />
              </div>
            </div>
          )}
          {rewindAsk && (() => {
            const c = convs.find((x) => x.id === active); const i = c?.messages.findIndex((m) => 'id' in m && m.id === rewindAsk) ?? -1
            const n = i < 0 || !c ? 0 : c.messages.slice(i + 1).filter((m) => m.k !== 'date').length
            return (
              <div className="absolute inset-0 z-50 grid place-items-center bg-black/30" onClick={() => setRewindAsk(null)}>
                <div data-testid="rewind-dialog" role="dialog" aria-label="回到这里" onClick={(e) => e.stopPropagation()} className="w-[340px] rounded-2xl bg-elev p-4 shadow-elev">
                  <div className="text-[15px] font-semibold">回到这条消息？</div>
                  <p className="mt-1.5 text-[13px] leading-relaxed text-fg-2">之后的 {n} 条会撤下，它们里等你回答的问题一起作废，对方从这里接着聊。已经做完的事撤不回。撤下后随时可以恢复。</p>
                  <div className="mt-3 flex gap-2">
                    <button onClick={() => setRewindAsk(null)} className="h-9 flex-1 rounded-lg bg-hover text-[13px] font-medium">取消</button>
                    <button data-testid="rewind-confirm" onClick={() => ctx.rewind(active, rewindAsk)} className="h-9 flex-1 rounded-lg bg-btn text-[13px] font-medium text-btn-fg">回到这里</button>
                  </div>
                </div>
              </div>
            )
          })()}
          {toastMsg && <div data-testid="toast" className="fade-up pointer-events-none absolute left-1/2 top-4 z-50 -translate-x-1/2 rounded-full bg-btn px-4 py-1.5 text-[13px] text-btn-fg shadow-elev">{toastMsg}</div>}
        </div>
      </TooltipProvider>
    </AppCtx.Provider>
  )
}


/* 待你处理：停在输入框正上方，独立一张卡，一次一件；可以跳到原消息 */
/* 置顶条（#1566，参照 mirasim / Telegram / QQ）：浮在消息流顶部的一条半透明窄条，左边一根竖线，
   显示最新一条置顶的作者和第一行；点文字跳到原消息并高亮，点右侧“N 条置顶 ›”在右栏展开列表；
   多条置顶时点一下换下一条（竖线分段显示第几条）。滚动时不占位，下面的消息从它底下穿过。 */

function withUnreadDivider(c: Conversation, n?: number): Msg[] {
  if (!n) return c.messages
  const idx: number[] = []
  c.messages.forEach((m, i) => { if (m.k === 'text' && m.from !== 'me') idx.push(i) })
  const at = idx[Math.max(0, idx.length - n)]
  if (at === undefined) return c.messages
  return [...c.messages.slice(0, at), { k: 'sys', id: 'new-divider', text: '—— 以下是新消息 ——' } as Msg, ...c.messages.slice(at)]
}

