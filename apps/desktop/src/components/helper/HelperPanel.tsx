import { useEffect, useRef, useState } from 'react'
import { X, Lock, FileText, Eye } from 'lucide-react'
import { useApp } from '@/ctx'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/icon-button'
import { panelAnswer } from './answers'
import { CHIPS, DEMO_CSV_NAME, DROP_ASK, DROPPED_FALLBACK, droppedLine, panelIntro } from './constants'
import { CsvConfirm, GroupConfirm } from './ConfirmCards'
import { AskBox, Bubble, Bulb } from './parts'
import { drafts, nid, panelItems } from './store'
import type { PItem } from './types'

/* 聊天窗口里的 Helper 面板:只读当前聊天,只有你看得到;在哪叫就在哪答(概念卡第 3 张,#1340 #1353 #1365) */

export function HelperPanel({ conv, width }: { conv: string; width: number }) {
  const { convs, createGroup, addTasks } = useApp()
  const c = convs.find((x) => x.id === conv)
  const title = c?.title ?? ''
  const intro = (): PItem[] => [{ id: nid(), from: 'helper', text: panelIntro(title) }]
  const [items, setItemsRaw] = useState<PItem[]>(() => panelItems.get(conv) ?? intro())
  const [input, setInput] = useState(() => drafts.get(conv) ?? '')
  const [drag, setDrag] = useState(false)
  const prev = useRef(conv)
  const end = useRef<HTMLDivElement>(null)

  const setItems = (f: (l: PItem[]) => PItem[]) => setItemsRaw((l) => { const n = f(l); panelItems.set(prev.current, n); return n })

  // 切换聊天:保存上一个聊天的草稿和对话,载入这个聊天的
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
    setItems((l) => [...l, { id: nid(), from: 'me', text: text.trim() }, panelAnswer(c, text, nid())])
  }
  const send = () => { ask(input); changeInput('') }
  const dropCsv = (name: string) => {
    if (!c) return
    setItems((l) => [...l, { id: nid(), from: 'me', text: droppedLine(name) }, panelAnswer(c, DROP_ASK, nid())])
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
      onDrop={(e) => { e.preventDefault(); setDrag(false); const f = e.dataTransfer.files?.[0]; dropCsv(f?.name ?? DROPPED_FALLBACK) }}
    >
      <PanelHeader title={title} />

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
            <Button key={t} data-testid={`hp-chip-${i}`} variant="outline" shape="pill" size="xs" onClick={() => ask(t)} className="h-auto min-h-7 whitespace-normal py-1 text-left font-normal text-fg-2 shadow-none">{t}</Button>
          ))}
          <Button data-testid="hp-drop-csv" variant="ghost" shape="pill" size="xs" onClick={() => dropCsv(DEMO_CSV_NAME)} className="border border-dashed border-line font-normal text-fg-3">
            <FileText />模拟拖入 {DEMO_CSV_NAME}
          </Button>
        </div>
        <AskBox value={input} onChange={changeInput} onSend={send} placeholder={`问 Helper（只读「${title}」）`} testid="hp-input" sendTestid="hp-send" />
      </div>

      {drag && (
        <div className="pointer-events-none absolute inset-2 z-10 grid place-items-center rounded-xl border-2 border-dashed border-warm bg-warm-soft/80 text-[14px] font-medium text-warm">松开就交给 Helper</div>
      )}
    </aside>
  )
}

/** 头部三层:名字 → 能读什么 → 谁看得到 */
function PanelHeader({ title }: { title: string }) {
  const { setHelperPanel } = useApp()
  return (
    <header className="flex items-start gap-2.5 border-b border-line px-3.5 py-3">
      <Bulb size={28} />
      <div className="min-w-0 flex-1">
        <div className="text-[14px] font-semibold leading-tight">Helper</div>
        <div data-testid="hp-scope" className="mt-1 flex min-w-0 items-center gap-1 text-[12px] text-fg-2"><Eye className="h-3.5 w-3.5 shrink-0" /><span className="truncate">能读：当前聊天 · {title}</span></div>
        <div className="mt-0.5 flex items-center gap-1 text-[11.5px] text-fg-3"><Lock className="h-3 w-3 shrink-0" />只有你看得到，这里说的话不会发到群里</div>
      </div>
      <IconButton data-testid="hp-close" label="关闭" size="icon-sm" icon={<X />} onClick={() => setHelperPanel(false)} className="-mr-1 -mt-0.5 text-fg-3" />
    </header>
  )
}
