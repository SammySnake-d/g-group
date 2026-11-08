import { useEffect, useId, useRef, useState } from 'react'
import { X, Lock, Eye } from 'lucide-react'
import { motion } from 'motion/react'
import { cn } from '@/lib/utils'
import { useApp } from '@/ctx'
import { transition } from '@/config/motion'
import { IconButton } from '@/components/ui/icon-button'
import { ListItem } from '@/components/ui/list-row'
import { openCronOverview } from '@/cronView'
import { globalAnswer, summaryOf } from './answers'
import { globalCommands } from './commands'
import { GLOBAL_DENIED } from './constants'
import { DraftCard, GrantCard } from './GlobalCards'
import { Bubble, Bulb } from './parts'
import { nid } from './store'
import type { DraftItem, GItem, GrantItem } from './types'

/* 全局 ⌘K:默认什么都不读;读要授权,发要草稿。Esc 关闭由 App 统一处理(先关这一层)。
   命令列表是 combobox + listbox:焦点留在输入框,↑↓ 移动选中(有输入时 ↑ 能退到「不选命令」),
   Enter 执行选中的命令 / 文字正好等于命令名就执行 / 否则把文字当问题发出。 */

/* ⌘K 呼出很频繁,只给库里最快的淡入(Emil:键盘高频操作不加位移动画);数值来自库 token */
const pop = { initial: { opacity: 0 }, animate: { opacity: 1, transition: transition.popOut } }

export function HelperGlobal() {
  const { convs, active, setHelperGlobal, setSection, push, pushMsg, toast, setPanoOpen } = useApp()
  const uid = useId()
  const [input, setInput] = useState('')
  const [items, setItems] = useState<GItem[]>([])
  const [granted, setGranted] = useState<string[]>([])
  const [sel, setSel] = useState(0)
  const end = useRef<HTMLDivElement>(null)
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }) }, [items])

  const close = () => setHelperGlobal(false)
  const titleOf = (id: string) => convs.find((c) => c.id === id)?.title ?? ''
  const patch = (id: string, f: (it: GItem) => GItem) => setItems((l) => l.map((x) => (x.id === id ? f(x) : x)))

  const ask = (raw: string) => {
    const text = raw.trim()
    if (!text) return
    setItems((l) => [...l, { id: nid(), from: 'me', text }, globalAnswer(text, convs, granted, nid)])
  }

  const cmds = globalCommands({
    activeTitle: titleOf(active),
    ask: (t) => { ask(t); setInput('') },
    fill: (t) => { setInput(t); setSel(-1) },
    close,
    newContact: () => { close(); push({ t: 'addContact' }, true) },
    newGroup: () => { close(); push({ t: 'newGroup' }, true) },
    plugins: () => { setSection('plugins'); close() },
    crons: () => { openCronOverview(setPanoOpen); close() },
    find: () => { close(); setSection('chat'); push({ t: 'search', id: active }, true) },
  })
  const q = input.trim()
  const shown = q ? cmds.filter((c) => c.label.includes(q) || q.includes(c.label)) : cmds
  const showList = (items.length === 0 || !q || shown.length > 0) && shown.length > 0
  const optId = (id: string) => `${uid}-opt-${id}`
  const listId = `${uid}-list`

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

  const sendDraft = (it: DraftItem) => {
    const body = it.draft.body.trim()
    if (!body) return
    pushMsg({ k: 'text', id: 'hg-' + nid(), from: 'me', text: body, byHelper: true }, it.draft.conv)
    patch(it.id, (x) => ({ ...x, draft: { ...it.draft, body, state: 'sent' } }) as GItem)
    toast(`已代你发到「${it.draft.title}」`)
  }
  const allow = (it: GrantItem, yes: boolean) => {
    patch(it.id, (x) => ({ ...x, grant: { ...it.grant, state: yes ? 'yes' : 'no' } }) as GItem)
    if (yes) {
      setGranted((g) => (g.includes(it.grant.conv) ? g : [...g, it.grant.conv]))
      setItems((l) => [...l, summaryOf(it.grant.conv, titleOf(it.grant.conv), nid())])
    } else setItems((l) => [...l, { id: nid(), from: 'helper', text: GLOBAL_DENIED }])
  }
  const cur = sel >= 0 && showList ? shown[sel] : undefined

  return (
    <div className="absolute inset-0 z-40">
      <div data-testid="hg-scrim" onClick={close} className="absolute inset-0 bg-black/30 backdrop-blur-[1px]" />
      <div className="pointer-events-none absolute inset-x-0 top-[12vh] flex justify-center px-4">
        <motion.div data-testid="helper-global" role="dialog" aria-label="Helper" {...pop}
          className="pointer-events-auto flex max-h-[70vh] w-[640px] max-w-full flex-col overflow-hidden rounded-2xl border border-line bg-elev shadow-elev">
          <div className="flex items-center gap-3 border-b border-line px-4 py-3">
            <Bulb size={26} />
            <input
              data-testid="hg-input"
              autoFocus
              role="combobox"
              aria-expanded={showList}
              aria-controls={showList ? listId : undefined}
              aria-activedescendant={cur ? optId(cur.id) : undefined}
              aria-autocomplete="list"
              value={input}
              onChange={(e) => { setInput(e.target.value); setSel(e.target.value.trim() ? -1 : 0) }}
              onKeyDown={onKey}
              placeholder="让 Helper 帮你做点什么…"
              className="h-8 min-w-0 flex-1 bg-transparent text-[16px] outline-none placeholder:text-fg-3"
            />
            <kbd className="rounded border border-line px-1.5 py-0.5 text-[11px] text-fg-3">Esc</kbd>
          </div>
          <div className="flex flex-wrap items-center gap-1.5 border-b border-line px-4 py-2 text-[12px] text-fg-2">
            <span data-testid="hg-scope" className="flex items-center gap-1"><Eye className="h-3.5 w-3.5" />能读：{granted.length ? '' : '没有读取任何聊天'}</span>
            {granted.map((g) => (
              <span key={g} data-testid={`hg-scope-chip-${g}`} className="flex min-w-0 items-center gap-0.5 rounded-full bg-hover py-0.5 pl-2 pr-0.5 text-fg">
                <span className="truncate">{titleOf(g)}</span>
                <IconButton data-testid={`hg-scope-remove-${g}`} label={`不再读「${titleOf(g)}」`} size="icon-xs" icon={<X />} onClick={() => setGranted((l) => l.filter((x) => x !== g))} className="h-5 w-5 rounded-full text-fg-3 hover:bg-line" />
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
                    {'grant' in it && <GrantCard grant={it.grant} onAnswer={(yes) => allow(it, yes)} />}
                    {'draft' in it && (
                      <DraftCard draft={it.draft} onSend={() => sendDraft(it)}
                        onBody={(v) => patch(it.id, (x) => ({ ...x, draft: { ...it.draft, body: v } }) as GItem)}
                        onCancel={() => patch(it.id, (x) => ({ ...x, draft: { ...it.draft, state: 'cancel' } }) as GItem)} />
                    )}
                  </Bubble>
                ))}
                <div ref={end} />
              </div>
            )}
            {showList && (
              <div className={cn('py-1.5', items.length > 0 && 'border-t border-line')}>
                <div id={`${listId}-label`} className="px-4 pb-1 pt-1.5 text-[11.5px] text-fg-3">常用</div>
                <div role="listbox" id={listId} aria-labelledby={`${listId}-label`}>
                  {shown.map((c, i) => (
                    <ListItem
                      key={c.id}
                      id={optId(c.id)}
                      role="option"
                      aria-selected={sel === i}
                      tabIndex={-1}
                      data-testid={c.testid ?? `hg-cmd-${c.id}`}
                      onMouseEnter={() => setSel(i)}
                      onClick={c.run}
                      media={<span className="text-fg-2 [&_svg]:h-4 [&_svg]:w-4">{c.icon}</span>}
                      title={<span className="font-normal">{c.label}</span>}
                      trailing={<span className="max-w-[45%] shrink-0 truncate text-[12px] text-fg-3">{c.hint}</span>}
                      className={cn('min-h-10 rounded-none px-4', sel === i && 'bg-sel hover:bg-sel')}
                    />
                  ))}
                </div>
              </div>
            )}
          </div>
          <div className="flex items-center gap-3 border-t border-line px-4 py-1.5 text-[11.5px] text-fg-3">
            <span>↑↓ 选择</span><span>Enter 执行或发送</span><span className="ml-auto">这里的对话不会出现在任何聊天里</span>
          </div>
        </motion.div>
      </div>
    </div>
  )
}
