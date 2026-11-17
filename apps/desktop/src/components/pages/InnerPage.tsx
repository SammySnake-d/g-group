import { useEffect, useRef, useState } from 'react'
import { people, innerLog, type Msg, type PersonId } from '@/data'
import { useApp } from '@/ctx'
import { Avatar } from '@/components/Avatar'
import { ComputeLine, MessageList, renderText } from '@/components/Messages'
import { Button } from '@/components/ui/button'
import { Surface } from '@/components/ui/surface'
import { PageFooter, PageScroll, Subhead } from './kit/parts'

/* ---------- US10-View 从群聊私信:看他在这个群里怎么安排活;在这里说话 = 在群里 @他 ---------- */
function InnerComposer({ id, conv }: { id: PersonId; conv: string }) {
  const { sendAs, convs } = useApp()
  const [t, setT] = useState('')
  const p = people[id]
  const cname = convs.find((x) => x.id === conv)?.title ?? ''
  const go = () => { const v = t.trim(); if (!v) return; sendAs(conv, `@${p.name} ${v}`); setT('') }
  return (
    <PageFooter>
      <div className="flex items-end gap-2 rounded-2xl border border-line bg-bg py-1.5 pl-3 pr-1.5 transition-[border-color] duration-fast ease-out focus-within:border-fg-3/50">
        <span className="max-w-[40%] shrink-0 truncate pb-[5px] text-[13.5px] font-medium text-me">@{p.name}</span>
        <textarea data-testid="inner-input" rows={1} value={t} onChange={(e) => setT(e.target.value)} aria-label={`在「${cname}」里对 ${p.name} 说`}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); go() } }}
          placeholder="说点什么" className="max-h-28 min-h-[22px] flex-1 resize-none bg-transparent py-[3px] text-[13.5px] leading-[22px] outline-none placeholder:text-fg-3" />
        <Button data-testid="inner-send" variant="ghost" size="xs" shape="pill" onClick={go} disabled={!t.trim()} className="text-me hover:text-me">发送</Button>
      </div>
      <div className="mt-1.5 truncate px-1 text-[11.5px] text-fg-3">发在「{cname}」里，大家都看得到</div>
    </PageFooter>
  )
}

export function InnerPage({ id, conv }: { id: PersonId; conv: string }) {
  const { computes, convs, typing } = useApp()
  const p = people[id]
  const c = convs.find((x) => x.id === conv)!
  const log = (innerLog[id] ?? []).filter((l) => l.conv === conv)
  const mine = Object.values(computes).filter((x) => x.owner === id && x.conv === conv)
  const said = c.messages.filter((m) => (m.k === 'text' && (m.from === id || (m.from === 'me' && m.text.includes('@' + p.name)))) || (m.k === 'compute' && m.from === id)) as Msg[]
  const end = useRef<HTMLDivElement>(null)
  useEffect(() => { end.current?.scrollIntoView() }, [said.length])
  return (
    <>
      <PageScroll className="px-4">
        <Surface elevation="sunken" className="mb-3 flex items-center gap-3 p-3" data-testid="inner">
          <Avatar id={id} size={36} />
          <p className="min-w-0 flex-1 text-[12.5px] leading-relaxed text-fg-2">这里和群聊是同一份记录：只显示和 {p.name} 有关的消息，加上它平时不在群里说的安排过程。在这里说的话会发到群里，等于在群里 @它。</p>
        </Surface>
        {mine.length > 0 && (
          <section className="mb-3">
            <Subhead>它在这个群里分出的 Compute</Subhead>
            {mine.map((x) => <div key={x.id}><ComputeLine id={x.id} /></div>)}
          </section>
        )}
        <Subhead>它怎么安排的</Subhead>
        <ol className="mb-4 border-l border-line pl-3">
          {log.map((l, i) => (
            <li key={i} className="relative pb-2.5 text-[13px] leading-relaxed">
              <span aria-hidden className="absolute -left-[16.5px] top-[7px] h-2 w-2 rounded-full border-2 border-elev bg-fg-3/60" />
              <span className="mr-2 text-[11.5px] tabular-nums text-fg-3">{l.at}</span>{renderText(l.text, false)}
            </li>
          ))}
          {!log.length && <li className="text-[13px] text-fg-3">还没有安排记录</li>}
        </ol>
        <Subhead>群里和它有关的消息</Subhead>
        <MessageList msgs={said} compact conv={conv} />
        {typing[conv] === id && <div className="ml-9 mt-1 text-[12px] text-fg-3">{p.name} 正在输入…</div>}
        <div ref={end} />
      </PageScroll>
      {/* U46(#2273):侧边栏里说话 = 在群里 @它。消息只有一份,发在群里,这里因为带 @它 也看得到 */}
      <InnerComposer id={id} conv={conv} />
    </>
  )
}
