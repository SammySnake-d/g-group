import { useEffect, useRef, useState } from 'react'
import { ArrowUp, Check, Sparkles } from 'lucide-react'
import { motion, useReducedMotion } from 'motion/react'
import { cn } from '@/lib/utils'
import { useApp } from '@/ctx'
import { HELPER_MARK } from '@/config/brand'
import { Bot } from '@/components/Avatar'
import { Button } from '@/components/ui/button'
import { Chip } from '@/components/ui/chip'
import { IconButton } from '@/components/ui/icon-button'
import { Surface } from '@/components/ui/surface'
import { HELPER_OFF_PANEL } from '@/components/helper/constants'
import { HelperOff } from '@/components/helper/parts'
import { appear } from './kit/motion'
import { HELPER_PAGE as H, IN_CONV } from './constants'
import { helperReply, type HelperMsg } from './helperReply'

/* ---------- 浮层里的 Helper:手动能做的事都能说;改东西前先出确认卡 ----------
   连着后端时:合同里没有让 Helper 生成回答的方法,不出本地剧本回答(helperReply 只在演示里用)——写明还不会回答,快捷问题和输入框不显示 */
export function HelperPage() {
  const ctx = useApp()
  const live = useApp((s) => s.backend.mode === 'connected')
  const reduced = useReducedMotion()
  const conv = ctx.convs.find((c) => c.id === ctx.active)
  const [msgs, setMsgs] = useState<HelperMsg[]>([{ from: 'helper', text: H.hello }])
  const [v, setV] = useState('')
  const end = useRef<HTMLDivElement>(null)
  useEffect(() => { end.current?.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth' }) }, [msgs.length, reduced])
  const say = (t: string) => {
    setMsgs((m) => [...m, { from: 'me', text: t }])
    setTimeout(() => {
      const { reply, openContact } = helperReply(t, ctx, conv?.title)
      if (openContact) setTimeout(() => ctx.push({ t: 'addContact' }), H.openDelay)
      setMsgs((m) => [...m, reply])
    }, H.replyDelay)
  }
  const settle = (i: number, keep: boolean) => setMsgs((x) => (keep ? x.map((y, j) => (j === i ? { ...y, card: { ...y.card!, done: true } } : y)) : x.filter((_, j) => j !== i)))
  return (
    <>
      <div className="flex items-center gap-2 px-4 pb-2">
        <Bot shape={HELPER_MARK.shape} color={HELPER_MARK.color} size={20} />
        <Chip size="md" className="min-w-0"><span className="truncate">{IN_CONV}{conv?.title}</span></Chip>
      </div>
      <div className="scroll-thin min-h-0 flex-1 space-y-2.5 overflow-y-auto px-4 pb-3" aria-live="polite">
        {live && <HelperOff testid="helper-off" detail={HELPER_OFF_PANEL} />}
        {!live && msgs.map((m, i) => (
          <div key={i} className={cn('flex flex-col', m.from === 'me' ? 'items-end' : 'items-start')}>
            <div className={cn('max-w-[86%] rounded-[16px] px-3 py-1.5 text-[14px] leading-relaxed', m.from === 'me' ? 'bg-me text-me-fg' : 'bg-hover')}>{m.text}</div>
            {m.card && (
              <motion.div {...(reduced ? {} : appear)} className="mt-1.5 w-[86%]">
                <Surface elevation="flat" className="p-3" data-testid="helper-card">
                  <div className="text-[14px] font-semibold">{m.card.title}</div>
                  <ul className="mt-1 space-y-0.5 text-[12.5px] text-fg-2">{m.card.lines.map((l) => <li key={l}>· {l}</li>)}</ul>
                  {m.card.done ? <div className="mt-2.5 flex items-center gap-1.5 text-[13px] text-ok"><Check className="h-4 w-4" />已完成</div> : (
                    <div className="mt-2.5 flex gap-2">
                      <Button data-testid="helper-confirm" variant="primary" className="flex-1" onClick={() => { m.card!.action(); settle(i, true) }}>确认</Button>
                      <Button className="flex-1" onClick={() => settle(i, false)}>取消</Button>
                    </div>
                  )}
                </Surface>
              </motion.div>
            )}
          </div>
        ))}
        <div ref={end} />
      </div>
      {!live && <div className="shrink-0 px-3 pb-3">
        <div className="no-scrollbar mb-2 flex gap-1.5 overflow-x-auto">
          {H.chips.map((c) => <Button key={c} data-testid="helper-chip" variant="outline" size="xs" shape="pill" onClick={() => say(c)} className="font-normal text-fg-2 shadow-none hover:text-fg">{c}</Button>)}
        </div>
        <form onSubmit={(e) => { e.preventDefault(); if (v.trim()) { say(v.trim()); setV('') } }} className="flex items-center gap-2 rounded-full bg-hover pl-4 pr-1 focus-within:ring-2 focus-within:ring-ring/25">
          <Sparkles aria-hidden className="h-4 w-4 shrink-0 text-fg-3" />
          <input autoFocus aria-label={H.placeholder} value={v} onChange={(e) => setV(e.target.value)} placeholder={H.placeholder} className="h-10 min-w-0 flex-1 bg-transparent text-[14px] outline-none placeholder:text-fg-3" />
          <IconButton type="submit" label="发送" tooltip={false} variant="primary" disabled={!v.trim()} icon={<ArrowUp />} className="rounded-full" />
        </form>
      </div>}
    </>
  )
}
