/* 聊天顶部只留一行（#1651 第 2 条）：左边是公告/置顶的轮换条（1/N 切换，点开看全部），右边是本群的清单、定时、插件小胶囊。
   公告和置顶在同一条里，用图标区分：喇叭 = 群公告（装配给助手），图钉 = 置顶消息（只给人看）。 */
import { useState, type ReactNode } from 'react'
import { ChevronDown, Clock, ListChecks, Megaphone, Pin, Plus, Puzzle } from 'lucide-react'
import { isInstalled } from '@g-group/ui-core'
import { useApp } from '@/ctx'
import { people, type Conversation, type Msg } from '@/data'
import { cronFailed } from '@/cronView'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { NOTICE, type GTab } from './constants'
import { loadedRatio, noticesOf } from './notices'

type Item = { k: 'notice'; id: string; text: string; ver: number; loaded: string } | { k: 'pin'; id: string; text: string; who: string }
const TONE = { warm: 'bg-warm-soft text-warm hover:bg-warm-soft hover:text-warm hover:brightness-95', err: 'bg-err-soft text-err hover:bg-err-soft hover:text-err hover:brightness-95' } as const

function Pill({ testid, onClick, children, tone }: { testid: string; onClick: () => void; children: ReactNode; tone?: keyof typeof TONE }) {
  return <Button data-testid={testid} variant="ghost" size="xs" shape="pill" onClick={onClick} className={cn('gap-1.5 px-2.5 text-[12px] font-normal tabular-nums', tone && TONE[tone])}>{children}</Button>
}

export function TopStrip({ conv, onOpen }: { conv: Conversation; onOpen: (tab: GTab) => void }) {
  const { checklist, crons, plugins, jump } = useApp()
  const items: Item[] = [
    ...noticesOf(conv).map((n) => { const r = loadedRatio(conv, n); return { k: 'notice' as const, id: n.id, text: n.text.split('\n')[0], ver: n.ver, loaded: `${r.ok}/${r.all}` } }),
    ...(conv.pins ?? []).map((pid) => { const m = conv.messages.find((x) => x.k === 'text' && x.id === pid) as Extract<Msg, { k: 'text' }> | undefined; return m ? { k: 'pin' as const, id: pid, text: m.text, who: people[m.from].name } : null }).filter(Boolean) as Item[],
  ]
  const [i, setI] = useState(0)
  const it = checklist.filter((t) => t.conv === conv.id)
  const done = it.filter((t) => t.status === '已完成').length
  const wait = it.filter((t) => t.status === '待验收').length
  const myCrons = crons.filter((c) => c.conv === conv.id)
  const myPlugins = plugins.filter((p) => isInstalled(p) && p.convs.includes(conv.id))
  const cur = items[i % Math.max(1, items.length)]
  return (
    <div data-testid="top-strip" className="flex h-10 shrink-0 items-center gap-1 border-b border-line px-3">
      {cur ? (
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          {items.length > 1 && <span aria-hidden className="flex h-6 w-[3px] shrink-0 flex-col gap-[2px]">{items.map((_, j) => <span key={j} className={cn('flex-1 rounded-full transition-colors duration-base', j === i % items.length ? 'bg-me' : 'bg-fg-3/30')} />)}</span>}
          <Button data-testid="strip-text" variant="ghost" size={null} onClick={() => (cur.k === 'pin' ? jump(cur.id) : onOpen('notice'))}
            className="h-8 min-w-0 flex-1 justify-start gap-1.5 rounded-md px-1 text-left font-normal text-fg hover:bg-hover/60 active:scale-100">
            {cur.k === 'notice' ? <Megaphone className="h-3.5 w-3.5 shrink-0 text-warm" /> : <Pin className="h-3.5 w-3.5 shrink-0 text-fg-3" />}
            <span key={cur.id} className="min-w-0 truncate text-[12.5px]">
              {cur.k === 'notice' ? <><span className="font-medium text-fg">{NOTICE.title}</span><span className="text-fg-2">：{cur.text}</span></> : <><span className="font-medium text-fg">{cur.who}</span><span className="text-fg-2">：{cur.text}</span></>}
            </span>
            {cur.k === 'notice' && <span data-testid="strip-loaded" className="shrink-0 text-[11px] tabular-nums text-fg-3">{cur.loaded} 已装配 v{cur.ver}</span>}
          </Button>
          {items.length > 1 && (
            <Button data-testid="strip-next" variant="ghost" size={null} title="下一条" onClick={() => setI((x) => (x + 1) % items.length)}
              className="h-7 shrink-0 gap-0.5 rounded-md px-1.5 text-[11.5px] font-normal tabular-nums text-fg-3 hover:text-fg">
              {(i % items.length) + 1}/{items.length}<ChevronDown className="h-3 w-3" />
            </Button>
          )}
        </div>
      ) : (
        <Button data-testid="strip-empty" variant="ghost" size={null} onClick={() => onOpen('notice')} className="h-8 flex-1 justify-start gap-1.5 px-1 text-[12.5px] font-normal text-fg-3 hover:bg-transparent hover:text-fg active:scale-100">
          <Megaphone className="h-3.5 w-3.5" />{NOTICE.empty}<Plus className="h-3.5 w-3.5" />
        </Button>
      )}
      <span aria-hidden className="mx-1 h-4 w-px shrink-0 bg-line" />
      {it.length > 0 && <Pill testid="strip-list" onClick={() => onOpen('list')} tone={wait ? 'warm' : undefined}><ListChecks />清单 {done}/{it.length}{wait > 0 && <span className="font-medium">· {wait} 待验收</span>}</Pill>}
      {myCrons.length > 0 && <Pill testid="strip-cron" onClick={() => onOpen('cron')} tone={myCrons.some(cronFailed) ? 'err' : undefined}><Clock />定时 {myCrons.length}</Pill>}
      {myPlugins.length > 0 && <Pill testid="strip-plugin" onClick={() => onOpen('plugin')}><Puzzle />插件 {myPlugins.length}</Pill>}
    </div>
  )
}
