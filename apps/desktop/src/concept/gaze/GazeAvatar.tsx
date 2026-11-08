import { useEffect, useRef, useState } from 'react'
import { examples, pointerGaze, type AvatarDefinition, type AvatarMotion } from 'open-bot-avatar'
import { mountAvatar, type MountedAvatar } from 'open-bot-avatar/dom'
import { gallery } from '@/avatars/gallery'
import { Avatar } from '@/components/Avatar'
import { useApp } from '@/ctx'
import { people, type Compute, type Msg, type Pending, type PersonId } from '@/data'
import { isWaitingMsg } from '../shared/waiting'
import { caretPoint } from './caret'

/* 概念 · 目光
   g-group 的助手头像本来就有会动的眼睛(open-bot-avatar)。平时它们静止,省 CPU;
   但当一条消息挂着「等你」的事(要你选、要你同意、做完等你验收),发这条消息的那个头像会看向输入框——
   它在等你回话。你点进输入框打字,它的眼睛跟着你的光标走;你一回答,它眯眼笑(库里的 happy 情绪),不再盯着你。
   一眼扫过去,哪些头像在「看你」,就是哪些事在等你。眼睛怎么转、多快、怎么缓,全交给头像库自己的跟随算法,我们只给目标点。 */
const defs: Record<string, AvatarDefinition> = { ...Object.fromEntries(examples.map((d) => [d.id, d])), ...gallery }
const BOX = '[data-testid=composer-box]'

/** 头像该看哪儿:输入框有焦点 → 光标;否则 → 输入框中间(你回话的地方) */
function target(): { x: number; y: number } | null {
  const box = document.querySelector<HTMLElement>(BOX)
  if (!box) return null
  const ta = box.querySelector('textarea')
  if (ta && document.activeElement === ta) return caretPoint(ta)
  const r = box.getBoundingClientRect()
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
}

/** 和消息流(Messages.tsx MessageList)的合并规则一致:同一个人 5 分钟内连着说、都不带引用、前一条没挂着等你的事或过程,
 *  就共用第一条的头像。所以这一串里任何一条在等你,头像都要看你 */
function runOf(msgs: Msg[], msgId: string, from: PersonId, pending: Pending[], computes: Record<string, Compute>) {
  const mins = (t?: string) => (t ? +t.slice(0, 2) * 60 + +t.slice(3, 5) : NaN)
  const ends = (x: Msg) => 'id' in x && (pending.some((p) => 'ask' in p && p.ask === x.id) || Object.values(computes).some((c) => c.reportMsg === x.id))
  const quoted = (x: Msg) => x.k === 'text' && !!x.quotes?.length
  /* 已经汇报过的 Compute 不单独占一行(折进汇报消息),合并时也不算它 */
  const ids0 = new Set(msgs.map((x) => ('id' in x ? x.id : '')))
  const folded = new Set(Object.values(computes).filter((c) => c.reportMsg && ids0.has(c.reportMsg)).map((c) => c.id))
  msgs = msgs.filter((x) => !(x.k === 'compute' && folded.has(x.computeId)))
  const i = msgs.findIndex((m) => 'id' in m && m.id === msgId)
  if (i < 0) return [msgId]
  const ids = [msgId]
  for (let k = i + 1; k < msgs.length; k++) {
    const prev = msgs[k - 1], m = msgs[k]
    if (!('from' in m) || m.from !== from || !('id' in m) || ends(prev) || quoted(prev) || quoted(m)) break
    if (prev.k === 'text' && m.k === 'text' && mins(m.at) - mins(prev.at) > 5) break
    ids.push(m.id)
  }
  return ids
}

export function GazeAvatar({ msgId, id, size }: { msgId: string; id: PersonId; size: number }) {
  const { pending, checklist, computes, convs, active } = useApp()
  const msgs = convs.find((c) => c.id === active)?.messages ?? []
  const waiting = runOf(msgs, msgId, id, pending, computes).some((x) => isWaitingMsg(x, pending, checklist, computes))
  /* 打开会话时就在等你的,才换成会看人的头像;其余照旧是静止头像(性能见 Avatar.tsx 的说明) */
  const [watched] = useState(waiting)
  const p = people[id]
  if (!watched || !p?.shape) return <Avatar id={id} size={size} status={false} />
  return <Watcher shape={p.shape} color={p.color!} name={p.name} size={size} waiting={waiting} msgId={msgId} />
}

function Watcher({ shape, color, name, size, waiting, msgId }: { shape: string; color: string; name: string; size: number; waiting: boolean; msgId: string }) {
  const host = useRef<HTMLSpanElement>(null)
  const inst = useRef<MountedAvatar | null>(null)
  const [seen, setSeen] = useState(true)
  const mood: AvatarMotion = waiting ? 'idle' : 'happy'

  useEffect(() => {
    inst.current = mountAvatar(host.current!, { definition: defs[shape] ?? defs.chat, color, mood, still: true, label: '' })
    return () => inst.current?.destroy()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shape])

  /* 离开视口就停帧(和 Avatar.tsx 一样的省电规则) */
  useEffect(() => {
    const el = host.current
    if (!el || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver(([e]) => setSeen(e.isIntersecting))
    io.observe(el)
    return () => io.disconnect()
  }, [])

  /* 跟着目标点:输入、移动光标、聚焦/失焦、滚动、窗口变化时更新一次(按帧合并)。
     省电(#1560):平时是一张静帧——眼睛停在看输入框的方向,不眨眼不晃;只有你在输入框里打字时才逐帧跟随光标 */
  useEffect(() => {
    const a = inst.current
    if (!a) return
    if (!waiting || !seen) { a.update({ mood, lookAt: null, still: true }); return }
    let raf = 0
    const look = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        const el = host.current
        const t = target()
        if (!el || !t) return
        const r = el.getBoundingClientRect()
        const g = pointerGaze(t, { left: r.left, top: r.top, width: r.width, height: r.height })
        const typing = document.activeElement?.closest(BOX) != null
        inst.current?.update({ lookAt: g, mood, still: !typing })
        el.dataset.look = `${g.x.toFixed(2)},${g.y.toFixed(2)}`
        el.dataset.live = typing ? '1' : '0'
      })
    }
    look()
    const evs: [EventTarget, string][] = [[document, 'selectionchange'], [document, 'input'], [document, 'focusin'], [document, 'focusout'], [window, 'resize']]
    for (const [t, e] of evs) t.addEventListener(e, look)
    document.addEventListener('scroll', look, true)
    return () => { cancelAnimationFrame(raf); for (const [t, e] of evs) t.removeEventListener(e, look); document.removeEventListener('scroll', look, true) }
  }, [waiting, seen, mood])

  return (
    <span className="relative inline-flex shrink-0" style={{ width: size, height: size }} aria-label={name}>
      <span ref={host} data-testid={`gaze-${msgId}`} data-mood={mood} data-watching={waiting ? '1' : '0'} className="block" style={{ width: size, height: size }} />
    </span>
  )
}
