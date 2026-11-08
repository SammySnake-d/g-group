import { useEffect, useRef, useState, type ReactNode } from 'react'
import { X, ArrowUp, Check, Lock, Search, UserPlus, Users, Puzzle, Clock, Send, FileText, Eye, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { people, dutyByConv, dutyDefault, type PersonId, type Msg, type Conversation } from '@/data'
import { useApp } from '@/ctx'
import { Avatar, Bot } from './Avatar'
import { openCronOverview } from '@/cronView'
import { Checkbox } from '@/components/ui/checkbox'

/* Helper：只为你服务；能读什么由入口决定；在哪叫就在哪答（概念卡第 3 张，#1340 #1353 #1365） */

let seq = 0
const nid = () => 'hl' + ++seq + '-' + Date.now().toString(36)
/** 面板输入框草稿：按聊天分别保存，切换聊天不丢 */
const drafts = new Map<string, string>()

const HELPER_COLOR = '#f8a01c'
const Bulb = ({ size = 22 }: { size?: number }) => <Bot shape="lightbulb" color={HELPER_COLOR} size={size} />

function dutiesOf(c: Conversation): { id: PersonId; duty: string }[] {
  const by = dutyByConv[c.id] ?? {}
  return c.members.filter((m) => m !== 'me' && !people[m]?.human).map((id) => ({ id, duty: by[id] ?? dutyDefault[id] ?? people[id]?.role ?? '' }))
}

/** 一条消息用一句话描述，给“带哪几条当背景”用 */
function msgLine(m: Msg): string {
  switch (m.k) {
    case 'text': return `${people[m.from]?.name ?? ''}：${m.text}`
    case 'huddle': return `${m.who.map((w) => people[w].name).join(' 和 ')} 的小范围讨论（${m.items.length} 条）`
    case 'summary': return `${people[m.from].name} 的总结：${m.title}`
    case 'vote': return `${people[m.from].name} 发起的投票：${m.title}`
    default: return ''
  }
}

/** 输入框：Enter 发送、Shift+Enter 换行、输入法组字时不发 */
function AskBox({ value, onChange, onSend, placeholder, testid, sendTestid }: { value: string; onChange: (v: string) => void; onSend: () => void; placeholder: string; testid: string; sendTestid: string }) {
  return (
    <div className="flex items-end gap-2 rounded-xl border border-line bg-bg px-3 py-2 focus-within:border-fg-3">
      <textarea
        data-testid={testid}
        value={value}
        rows={1}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); onSend() }
        }}
        className="max-h-32 min-h-[22px] flex-1 resize-none bg-transparent text-[14px] leading-[22px] outline-none placeholder:text-fg-3"
      />
      <button data-testid={sendTestid} onClick={onSend} disabled={!value.trim()} aria-label="发送" className={cn('grid h-7 w-7 shrink-0 place-items-center rounded-lg', value.trim() ? 'bg-me text-me-fg' : 'bg-hover text-fg-3')}>
        <ArrowUp className="h-4 w-4" />
      </button>
    </div>
  )
}

function Card({ title, children, done }: { title: ReactNode; children: ReactNode; done?: ReactNode }) {
  return (
    <div className="mt-2 overflow-hidden rounded-xl border border-line bg-bg">
      <div className="border-b border-line px-3 py-2 text-[12.5px] font-medium text-fg-2">{title}</div>
      <div className="px-3 py-2.5 text-[13.5px]">{children}</div>
      {done && <div className="flex items-center gap-1.5 border-t border-line px-3 py-2 text-[12.5px] text-fg-3"><Check className="h-3.5 w-3.5" />{done}</div>}
    </div>
  )
}

function Bubble({ from, children }: { from: 'me' | 'helper'; children: ReactNode }) {
  if (from === 'me') return <div className="flex justify-end"><div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-me px-3 py-2 text-[13.5px] text-me-fg">{children}</div></div>
  return (
    <div className="flex gap-2">
      <div className="mt-0.5 shrink-0"><Bulb size={22} /></div>
      <div className="min-w-0 flex-1 whitespace-pre-wrap text-[13.5px] leading-relaxed">{children}</div>
    </div>
  )
}

/* ======================= 聊天窗口里的 Helper 面板：只读当前聊天，只有你看得到 ======================= */

type GroupCard = { title: string; picks: Record<PersonId, boolean>; bg: { id: string; text: string; on: boolean }[]; done?: string }
type CsvCard = { rows: { text: string; who?: PersonId; why: string }[]; done?: boolean }
type PItem =
  | { id: string; from: 'me' | 'helper'; text: string }
  | { id: string; from: 'helper'; text: string; group: GroupCard }
  | { id: string; from: 'helper'; text: string; csv: CsvCard }

const CSV_ROWS: { text: string; keys: string[] }[] = [
  { text: '飞书接入方案', keys: ['需求', '接入'] },
  { text: '设计规范 v1', keys: ['设计规范', '规范'] },
  { text: '插件中心原型', keys: ['原型', '前端'] },
  { text: '定时总览', keys: ['定时', '巡检'] },
]
const CHIPS = ['拉 Claude Code 和 Argon 另开个群聊外部记录接入', '把功能清单 CSV 转成本群清单', '本群谁适合做飞书接入？']

function csvCard(c: Conversation): CsvCard {
  const by = dutyByConv[c.id] ?? {}
  const rows = CSV_ROWS.map(({ text, keys }) => {
    const hit = Object.entries(by).find(([id, d]) => c.members.includes(id) && keys.some((k) => d.includes(k)))
    return hit ? { text, who: hit[0], why: `本群分工：${hit[1]}` } : { text, why: '' }
  })
  return { rows }
}

function groupCard(c: Conversation, ask: string): GroupCard {
  const named = c.members.filter((m) => m !== 'me' && !people[m]?.human && ask.includes(people[m].name))
  const ids: PersonId[] = named.length ? named : ['claude', 'argon'].filter((m) => c.members.includes(m))
  const want = ['g10', 'g11', 'g12']
  let bg = c.messages.filter((m) => 'id' in m && want.includes(m.id)).map((m) => ({ id: (m as { id: string }).id, text: msgLine(m), on: true }))
  if (!bg.length) bg = c.messages.filter((m) => msgLine(m)).slice(-3).map((m) => ({ id: (m as { id: string }).id, text: msgLine(m), on: true }))
  const topic = ask.match(/聊(.+?)$/)?.[1]?.replace(/[，。,.!！?？]/g, '').trim()
  return { title: topic || '新的讨论', picks: Object.fromEntries(ids.map((i) => [i, true])), bg }
}

function answer(c: Conversation, ask: string): PItem {
  const id = nid()
  if (/另开|拉.*群|新群|建群/.test(ask)) return { id, from: 'helper', text: '好。原群里什么都不会多，新群建好后我把你选的几条带过去当背景。看一下：', group: groupCard(c, ask) }
  if (/csv|CSV|表格|清单/.test(ask)) return { id, from: 'helper', text: '我把表格读成了 4 项，按本群的分工给每项推荐了人。确认后它们进本群的清单（清单属于群），并在群里 @所有人认领。', csv: csvCard(c) }
  if (/谁适合|谁来|谁做/.test(ask)) {
    const list = dutiesOf(c)
    const best = list.find((x) => /需求|文档|接入/.test(x.duty))
    const lines = list.map((x) => `· ${people[x.id].name}：${x.duty}`).join('\n')
    return { id, from: 'helper', text: `本群的分工：\n${lines}\n\n${best ? `飞书接入偏需求和方案，按分工 ${people[best.id].name} 最合适。` : '分工里没有正好对上的，可以在群里问谁有空。'}` }
  }
  return { id, from: 'helper', text: `我只读得到「${c.title}」。想另拉个群、把表格转成本群清单、或者看看谁适合做某件事，都可以直接说。这里说的话不会发到群里。` }
}

const panelItems = new Map<string, PItem[]>()

export function HelperPanel({ conv, width }: { conv: string; width: number }) {
  const { convs, createGroup, addTasks } = useApp()
  const c = convs.find((x) => x.id === conv)
  const title = c?.title ?? ''
  const intro = (): PItem[] => [{ id: nid(), from: 'helper', text: `我读得到「${title}」的成员和最近的消息。想另拉个群、把表格转成清单，都可以跟我说。` }]
  const [items, setItemsRaw] = useState<PItem[]>(() => panelItems.get(conv) ?? intro())
  const [input, setInput] = useState(() => drafts.get(conv) ?? '')
  const [drag, setDrag] = useState(false)
  const prev = useRef(conv)
  const end = useRef<HTMLDivElement>(null)

  const setItems = (f: (l: PItem[]) => PItem[]) => setItemsRaw((l) => { const n = f(l); panelItems.set(prev.current, n); return n })

  // 切换聊天：保存上一个聊天的草稿和对话，载入这个聊天的
  useEffect(() => {
    if (prev.current === conv) return
    prev.current = conv
    setInput(drafts.get(conv) ?? '')
    setItemsRaw(panelItems.get(conv) ?? intro())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conv])
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }) }, [items.length])

  const changeInput = (v: string) => { setInput(v); if (v) drafts.set(conv, v); else drafts.delete(conv) }
  const ask = (text: string) => {
    if (!c || !text.trim()) return
    setItems((l) => [...l, { id: nid(), from: 'me', text: text.trim() }, answer(c, text)])
  }
  const send = () => { ask(input); changeInput('') }
  const dropCsv = (name: string) => {
    if (!c) return
    setItems((l) => [...l, { id: nid(), from: 'me', text: `（拖进来一个文件：${name}）` }, answer(c, 'CSV 转成本群清单')])
  }
  const patch = (id: string, f: (it: PItem) => PItem) => setItems((l) => l.map((x) => (x.id === id ? f(x) : x)))

  if (!c) return <aside data-testid="helper-panel" style={{ width }} />
  return (
    <aside
      data-testid="helper-panel"
      data-conv={conv}
      style={{ width }}
      className="relative flex h-full shrink-0 flex-col border-l border-line bg-side"
      onDragOver={(e) => { e.preventDefault(); setDrag(true) }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDrag(false) }}
      onDrop={(e) => { e.preventDefault(); setDrag(false); const f = e.dataTransfer.files?.[0]; dropCsv(f?.name ?? '拖入的文件') }}
    >
      <header className="flex items-start gap-2.5 border-b border-line px-3.5 py-3">
        <Bulb size={28} />
        <div className="min-w-0 flex-1">
          <div className="text-[14px] font-semibold">Helper</div>
          <div data-testid="hp-scope" className="mt-0.5 flex items-center gap-1 truncate text-[12px] text-fg-2"><Eye className="h-3.5 w-3.5 shrink-0" />能读：当前聊天 · {title}</div>
          <div className="mt-0.5 flex items-center gap-1 text-[11.5px] text-fg-3"><Lock className="h-3 w-3" />只有你看得到，这里说的话不会发到群里</div>
        </div>
        <CloseBtn testid="hp-close" />
      </header>

      <div className="scroll-thin flex-1 space-y-3 overflow-y-auto px-3.5 py-3">
        {items.map((it) => (
          <Bubble key={it.id} from={it.from}>
            {it.text}
            {'group' in it && <GroupConfirm c={c} card={it.group} onChange={(g) => patch(it.id, (x) => ({ ...x, group: g }) as PItem)} onCreate={() => {
              const g = it.group
              const ids = Object.keys(g.picks).filter((k) => g.picks[k])
              const n = g.bg.filter((b) => b.on).length
              patch(it.id, (x) => ({ ...x, group: { ...g, done: `已创建「${g.title}」` } }) as PItem)
              createGroup(g.title, ids, `来自「${c.title}」：Helper 按你的要求另开的群，带了 ${n} 条背景`)
            }} />}
            {'csv' in it && <CsvConfirm card={it.csv} onChange={(v) => patch(it.id, (x) => ({ ...x, csv: v }) as PItem)} onConfirm={() => {
              addTasks(c.id, it.csv.rows.map((r) => r.text))
              patch(it.id, (x) => ({ ...x, csv: { ...it.csv, done: true } }) as PItem)
            }} />}
          </Bubble>
        ))}
        <div ref={end} />
      </div>

      <div className="space-y-2 border-t border-line px-3 py-2.5">
        <div className="flex flex-wrap gap-1.5">
          {CHIPS.map((t, i) => (
            <button key={t} data-testid={`hp-chip-${i}`} onClick={() => ask(t)} className="rounded-full border border-line bg-bg px-2.5 py-1 text-[12px] text-fg-2 hover:bg-hover">{t}</button>
          ))}
          <button data-testid="hp-drop-csv" onClick={() => dropCsv('功能清单.csv')} className="flex items-center gap-1 rounded-full border border-dashed border-line px-2.5 py-1 text-[12px] text-fg-3 hover:bg-hover"><FileText className="h-3.5 w-3.5" />模拟拖入 功能清单.csv</button>
        </div>
        <AskBox value={input} onChange={changeInput} onSend={send} placeholder={`问 Helper（只读「${title}」）`} testid="hp-input" sendTestid="hp-send" />
      </div>

      {drag && (
        <div className="pointer-events-none absolute inset-2 z-10 grid place-items-center rounded-xl border-2 border-dashed border-warm bg-warm-soft/80 text-[14px] font-medium text-warm">松开就交给 Helper</div>
      )}
    </aside>
  )
}

function CloseBtn({ testid }: { testid: string }) {
  const { setHelperPanel } = useApp()
  return <button data-testid={testid} onClick={() => setHelperPanel(false)} aria-label="关闭" className="grid h-7 w-7 place-items-center rounded-lg text-fg-3 hover:bg-hover hover:text-fg"><X className="h-4 w-4" /></button>
}

function GroupConfirm({ c, card, onChange, onCreate }: { c: Conversation; card: GroupCard; onChange: (g: GroupCard) => void; onCreate: () => void }) {
  const by = dutyByConv[c.id] ?? {}
  const ids = Object.keys(card.picks)
  const n = card.bg.filter((b) => b.on).length
  const ok = ids.some((i) => card.picks[i]) && card.title.trim()
  return (
    <Card title="另开一个群" done={card.done && `${card.done}，原群「${c.title}」里没有多任何消息`}>
      <label className="block text-[12px] text-fg-3">新群名</label>
      <input value={card.title} disabled={!!card.done} onChange={(e) => onChange({ ...card, title: e.target.value })} className="mt-1 h-8 w-full rounded-lg border border-line bg-bg px-2.5 text-[13.5px] outline-none focus:border-fg-3" />
      <div className="mt-3 text-[12px] text-fg-3">拉谁（按本群分工推荐）</div>
      <div className="mt-1 space-y-1.5">
        {ids.map((id) => (
          <label key={id} className="flex cursor-pointer items-start gap-2">
            <Checkbox checked={card.picks[id]} disabled={!!card.done} onCheckedChange={(v) => onChange({ ...card, picks: { ...card.picks, [id]: !!v } })} className="mt-1 rounded-[5px]" />
            <Avatar id={id} size={22} status={false} />
            <span className="min-w-0 flex-1 leading-snug">{people[id].name}<span className="block text-[12px] text-fg-3">推荐理由：本群里负责「{by[id] ?? dutyDefault[id]}」</span></span>
          </label>
        ))}
      </div>
      <div className="mt-3 text-[12px] text-fg-3">带哪几条当背景（{n} 条）</div>
      <div className="mt-1 space-y-1.5">
        {card.bg.map((b) => (
          <label key={b.id} className="flex cursor-pointer items-start gap-2">
            <Checkbox checked={b.on} disabled={!!card.done} onCheckedChange={(v) => onChange({ ...card, bg: card.bg.map((x) => (x.id === b.id ? { ...x, on: !!v } : x)) })} className="mt-1 rounded-[5px]" />
            <span className="line-clamp-2 flex-1 text-[13px] text-fg-2">{b.text}</span>
          </label>
        ))}
      </div>
      {!card.done && (
        <button data-testid="hp-create-group" disabled={!ok} onClick={onCreate} className={cn('mt-3 h-8 w-full rounded-lg text-[13.5px] font-medium', ok ? 'bg-me text-me-fg' : 'bg-hover text-fg-3')}>创建</button>
      )}
    </Card>
  )
}

function CsvConfirm({ card, onChange, onConfirm }: { card: CsvCard; onChange: (v: CsvCard) => void; onConfirm: () => void }) {
  return (
    <Card title={`功能清单.csv · ${card.rows.length} 行`} done={card.done && `已建成本群清单 ${card.rows.length} 项，并在群里 @所有人`}>
      <div className="space-y-1.5">
        {card.rows.map((r, i) => (
          <div key={r.text} className="group flex items-start gap-2">
            <span className="w-4 shrink-0 pt-0.5 text-[12px] text-fg-3">{i + 1}</span>
            <span className="min-w-0 flex-1 leading-snug">{r.text}<span className="block text-[12px] text-fg-3">{r.who ? `推荐：${people[r.who].name}（${r.why}）` : '推荐：谁有空谁领'}</span></span>
            {!card.done && <button aria-label="删掉这行" onClick={() => onChange({ ...card, rows: card.rows.filter((_, j) => j !== i) })} className="grid h-6 w-6 place-items-center rounded text-fg-3 hover:bg-hover hover:text-err"><Trash2 className="h-3.5 w-3.5" /></button>}
          </div>
        ))}
      </div>
      {!card.done && (
        <button data-testid="hp-csv-confirm" disabled={!card.rows.length} onClick={onConfirm} className={cn('mt-3 h-8 w-full rounded-lg text-[13.5px] font-medium', card.rows.length ? 'bg-me text-me-fg' : 'bg-hover text-fg-3')}>建成本群清单并 @所有人</button>
      )}
    </Card>
  )
}

/* ======================= 全局 ⌘K：默认什么都不读；读要授权，发要草稿 ======================= */

type GItem =
  | { id: string; from: 'me' | 'helper'; text: string }
  | { id: string; from: 'helper'; text: string; grant: { conv: string; title: string; n: number; ask: string; state?: 'yes' | 'no' } }
  | { id: string; from: 'helper'; text: string; draft: { conv: string; title: string; body: string; state?: 'sent' | 'cancel' } }

type Cmd = { id: string; label: string; hint: string; icon: ReactNode; testid?: string; run: () => void }

const READ_ASK = '总结一下前端设计讨论今天说了什么'
const SEND_ASK = '代我在模型助手群聊说：今晚 10 点前别合并'

export function HelperGlobal() {
  const { convs, active, setHelperGlobal, setSection, push, pushMsg, toast, setPanoOpen } = useApp()
  const [input, setInput] = useState('')
  const [items, setItems] = useState<GItem[]>([])
  const [granted, setGranted] = useState<string[]>([])
  const [sel, setSel] = useState(0)
  const end = useRef<HTMLDivElement>(null)
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }) }, [items])

  const close = () => setHelperGlobal(false)
  const titleOf = (id: string) => convs.find((c) => c.id === id)?.title ?? ''
  const findConv = (text: string) => [...convs].sort((a, b) => b.title.length - a.title.length).find((c) => c.kind === 'group' && text.includes(c.title))
  const patch = (id: string, f: (it: GItem) => GItem) => setItems((l) => l.map((x) => (x.id === id ? f(x) : x)))

  const ask = (raw: string) => {
    const text = raw.trim()
    if (!text) return
    const me: GItem = { id: nid(), from: 'me', text }
    const target = findConv(text)
    const sendM = text.match(/^代我在(.+?)(?:里|群里)?说[:：]\s*(.+)$/)
    if (sendM) {
      const c = findConv(sendM[1])
      if (!c) { setItems((l) => [...l, me, { id: nid(), from: 'helper', text: `我没找到「${sendM[1]}」这个群。你说一下完整的群名？` }]); return }
      setItems((l) => [...l, me, { id: nid(), from: 'helper', text: '草稿在这里，你点「发送」我才发：', draft: { conv: c.id, title: c.title, body: sendM[2] } }])
      return
    }
    if (target && /总结|说了什么|聊了什么|读|看看/.test(text)) {
      if (granted.includes(target.id)) { setItems((l) => [...l, me, summaryOf(target.id)]); return }
      const n = target.id === 'g-design' ? 12 : target.messages.filter((m) => m.k === 'text').length
      setItems((l) => [...l, me, { id: nid(), from: 'helper', text: '', grant: { conv: target.id, title: target.title, n, ask: text } }])
      return
    }
    setItems((l) => [...l, me, { id: nid(), from: 'helper', text: granted.length ? `我现在只读了${granted.map((g) => `「${titleOf(g)}」`).join('')}。要我做什么具体的事，直接说。` : '我现在没有读取任何聊天。要我看某个群，告诉我群名，我会先问你能不能读；要我代你发消息，我会先给你看草稿。' }])
  }

  const summaryOf = (cid: string): GItem => ({
    id: nid(), from: 'helper',
    text: cid === 'g-design'
      ? '「前端设计讨论」今天说了这些：\n1. Grok 去抓 GrokBot 的设计文章，网页打不开，失败了 3 次，还在等你决定。\n2. Grok 把上海天气答成了广州的数据，Astra 纠正了，Grok 认了。\n3. 状态存储投票：Claude Code 和 Astra 选 SQLite，Grok 选内容寻址文件，等你拍板。'
      : `「${titleOf(cid)}」最近的讨论我读过了，你想知道哪一块？`,
  })

  const fill = (t: string) => { setInput(t); setSel(-1) }
  const cmds: Cmd[] = [
    { id: 'read', label: READ_ASK, hint: '试试：先问你能不能读', icon: <Eye className="h-4 w-4" />, testid: 'hg-cmd-read', run: () => { ask(READ_ASK); setInput('') } },
    { id: 'send', label: SEND_ASK, hint: '试试：先给你看草稿', icon: <Send className="h-4 w-4" />, testid: 'hg-cmd-send', run: () => { ask(SEND_ASK); setInput('') } },
    { id: 'contact', label: '新建联系人', hint: '打开新建联系人', icon: <UserPlus className="h-4 w-4" />, run: () => { close(); push({ t: 'addContact' }, true) } },
    { id: 'group', label: '发起群聊', hint: '选人建一个新群', icon: <Users className="h-4 w-4" />, run: () => { close(); push({ t: 'newGroup' }, true) } },
    { id: 'plugins', label: '装插件', hint: '去「插件」', icon: <Puzzle className="h-4 w-4" />, run: () => { setSection('plugins'); close() } },
    { id: 'crons', label: '看所有定时', hint: '打开「进展」，停在定时那一节', icon: <Clock className="h-4 w-4" />, run: () => { openCronOverview(setPanoOpen); close() } },
    { id: 'find', label: '找某次聊天', hint: `在「${titleOf(active)}」里搜`, icon: <Search className="h-4 w-4" />, run: () => { close(); setSection('chat'); push({ t: 'search', id: active }, true) } },
    { id: 'say', label: '代我在某个群发一句话', hint: '先出草稿，你点了才发', icon: <Send className="h-4 w-4" />, run: () => fill('代我在模型助手群聊说：') },
  ]
  const q = input.trim()
  const shown = q ? cmds.filter((c) => c.label.includes(q) || q.includes(c.label)) : cmds
  const showList = items.length === 0 || !q || shown.length > 0

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return
    const max = shown.length - 1
    if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(max, s + 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(q ? -1 : 0, s - 1)) }
    else if (e.key === 'Enter') {
      e.preventDefault()
      const exact = cmds.find((c) => c.label === q)
      if (sel >= 0 && shown[sel]) shown[sel].run()
      else if (exact) exact.run()
      else if (q) { ask(q); setInput('') }
    }
  }

  const sendDraft = (it: Extract<GItem, { draft: unknown }>) => {
    const body = it.draft.body.trim()
    if (!body) return
    pushMsg({ k: 'text', id: 'hg-' + nid(), from: 'me', text: body, byHelper: true }, it.draft.conv)
    patch(it.id, (x) => ({ ...x, draft: { ...it.draft, body, state: 'sent' } }) as GItem)
    toast(`已代你发到「${it.draft.title}」`)
  }
  const allow = (it: Extract<GItem, { grant: unknown }>, yes: boolean) => {
    patch(it.id, (x) => ({ ...x, grant: { ...it.grant, state: yes ? 'yes' : 'no' } }) as GItem)
    if (yes) {
      setGranted((g) => (g.includes(it.grant.conv) ? g : [...g, it.grant.conv]))
      setItems((l) => [...l, summaryOf(it.grant.conv)])
    } else setItems((l) => [...l, { id: nid(), from: 'helper', text: '好，不读。没有读到这个群的内容，就没法总结；你想换个问法也可以。' }])
  }

  return (
    <div className="absolute inset-0 z-40">
      <div data-testid="hg-scrim" onClick={close} className="absolute inset-0 bg-black/30 backdrop-blur-[1px]" />
      <div data-testid="helper-global" className="fade-up absolute left-1/2 top-[12vh] flex max-h-[70vh] w-[640px] max-w-[calc(100%-32px)] -translate-x-1/2 flex-col overflow-hidden rounded-2xl border border-line bg-elev shadow-elev">
        <div className="flex items-center gap-3 border-b border-line px-4 py-3">
          <Bulb size={26} />
          <input
            data-testid="hg-input"
            autoFocus
            value={input}
            onChange={(e) => { setInput(e.target.value); setSel(e.target.value.trim() ? -1 : 0) }}
            onKeyDown={onKey}
            placeholder="让 Helper 帮你做点什么…"
            className="h-8 flex-1 bg-transparent text-[16px] outline-none placeholder:text-fg-3"
          />
          <kbd className="rounded border border-line px-1.5 py-0.5 text-[11px] text-fg-3">Esc</kbd>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 border-b border-line px-4 py-2 text-[12px] text-fg-2">
          <span data-testid="hg-scope" className="flex items-center gap-1"><Eye className="h-3.5 w-3.5" />能读：{granted.length ? '' : '没有读取任何聊天'}</span>
          {granted.map((g) => (
            <span key={g} data-testid={`hg-scope-chip-${g}`} className="flex items-center gap-1 rounded-full bg-hover py-0.5 pl-2 pr-1 text-fg">
              {titleOf(g)}
              <button aria-label={`不再读「${titleOf(g)}」`} data-testid={`hg-scope-remove-${g}`} onClick={() => setGranted((l) => l.filter((x) => x !== g))} className="grid h-4 w-4 place-items-center rounded-full text-fg-3 hover:bg-line hover:text-fg"><X className="h-3 w-3" /></button>
            </span>
          ))}
          <span className="ml-auto flex items-center gap-1 text-fg-3"><Lock className="h-3 w-3" />只有你看得到</span>
        </div>

        <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
          {items.length > 0 && (
            <div className="space-y-3 px-4 py-3">
              {items.map((it) => (
                <Bubble key={it.id} from={it.from}>
                  {it.text}
                  {'grant' in it && (
                    <div className={cn('rounded-xl border px-3 py-2.5', it.grant.state ? 'border-line bg-bg' : 'border-warm/40 bg-warm-soft')}>
                      <div className={cn('text-[13.5px]', !it.grant.state && 'font-semibold')}>要读「{it.grant.title}」今天的 {it.grant.n} 条消息，可以吗？</div>
                      <div className="mt-0.5 text-[12px] text-fg-2">只用于回答这个问题。读过之后会列在上面“能读”一栏，点 × 就移掉。</div>
                      {it.grant.state ? (
                        <div className="mt-2 flex items-center gap-1.5 text-[12.5px] text-fg-3"><Check className="h-3.5 w-3.5" />{it.grant.state === 'yes' ? '你允许了' : '你选了不读'}</div>
                      ) : (
                        <div className="mt-2.5 flex gap-2">
                          <button data-testid="hg-allow" onClick={() => allow(it, true)} className="h-8 rounded-lg bg-me px-4 text-[13px] font-medium text-me-fg">允许</button>
                          <button data-testid="hg-deny" onClick={() => allow(it, false)} className="h-8 rounded-lg border border-line bg-bg px-4 text-[13px] hover:bg-hover">不读</button>
                        </div>
                      )}
                    </div>
                  )}
                  {'draft' in it && (
                    <Card title="代发草稿" done={it.draft.state === 'sent' ? `已发到「${it.draft.title}」，消息上标着“由 Helper 代发”` : it.draft.state === 'cancel' ? '已取消，没有发' : undefined}>
                      <div className="grid grid-cols-[64px_1fr] gap-y-1.5 text-[13px]">
                        <span className="text-fg-3">发到</span><span>「{it.draft.title}」</span>
                        <span className="text-fg-3">身份</span><span>你（由 Helper 代发）</span>
                        <span className="text-fg-3">正文</span>
                        <textarea data-testid="hg-draft-body" value={it.draft.body} disabled={!!it.draft.state} rows={2} onChange={(e) => patch(it.id, (x) => ({ ...x, draft: { ...it.draft, body: e.target.value } }) as GItem)} className="resize-none rounded-lg border border-line bg-bg px-2 py-1 text-[13.5px] outline-none focus:border-fg-3" />
                      </div>
                      {!it.draft.state && (
                        <div className="mt-2.5 flex gap-2">
                          <button data-testid="hg-send-confirm" onClick={() => sendDraft(it)} disabled={!it.draft.body.trim()} className="h-8 rounded-lg bg-me px-4 text-[13px] font-medium text-me-fg">发送</button>
                          <button data-testid="hg-send-cancel" onClick={() => patch(it.id, (x) => ({ ...x, draft: { ...it.draft, state: 'cancel' } }) as GItem)} className="h-8 rounded-lg border border-line bg-bg px-4 text-[13px] hover:bg-hover">取消</button>
                        </div>
                      )}
                    </Card>
                  )}
                </Bubble>
              ))}
              <div ref={end} />
            </div>
          )}
          {showList && shown.length > 0 && (
            <div className={cn('py-1.5', items.length > 0 && 'border-t border-line')}>
              <div className="px-4 pb-1 pt-1.5 text-[11.5px] text-fg-3">常用</div>
              {shown.map((c, i) => (
                <button
                  key={c.id}
                  data-testid={c.testid ?? `hg-cmd-${c.id}`}
                  onMouseEnter={() => setSel(i)}
                  onClick={c.run}
                  className={cn('flex w-full items-center gap-3 px-4 py-2 text-left text-[14px]', sel === i ? 'bg-sel' : 'hover:bg-hover')}
                >
                  <span className="text-fg-2">{c.icon}</span>
                  <span className="flex-1 truncate">{c.label}</span>
                  <span className="text-[12px] text-fg-3">{c.hint}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="flex items-center gap-3 border-t border-line px-4 py-1.5 text-[11.5px] text-fg-3">
          <span>↑↓ 选择</span><span>Enter 执行或发送</span><span className="ml-auto">这里的对话不会出现在任何聊天里</span>
        </div>
      </div>
    </div>
  )
}
