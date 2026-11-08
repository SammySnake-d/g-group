import { useEffect, useRef, useState } from 'react'
import { examples, type AvatarDefinition, type AvatarMotion } from 'open-bot-avatar'
import { mountAvatar, type MountedAvatar } from 'open-bot-avatar/dom'
import { gallery } from '@/avatars/gallery'
import { cn } from '@/lib/utils'
import { people, type PersonId } from '@/data'
import { useApp } from '@/ctx'

/* 头像库：open-bot-avatar（MIT，Dominik Scholz）。几何形状 + 会眨、会跟随鼠标的眼睛 */
const defs: Record<string, AvatarDefinition> = { ...Object.fromEntries(examples.map((d) => [d.id, d])), ...gallery }
export type Mood = AvatarMotion

/* 性能（#1560 CPU 占满）：原来每个 ≥22px 的头像都是一个每帧重绘的活动 SVG，一屏上百个，主线程常年 60fps 在画眼睛。
   现在默认静止，只有三种情况会动：鼠标悬停在它上面、它正在回复（mood=thinking）、大头像且跟随鼠标（资料页）。
   动的那几个离开视口或页面切到后台也停。 */
export function Bot({ shape, color, size, mood = 'idle', follow = false, still }: { shape: string; color: string; size: number; mood?: Mood; follow?: boolean; still?: boolean }) {
  const host = useRef<HTMLSpanElement>(null)
  const inst = useRef<MountedAvatar | null>(null)
  const [hover, setHover] = useState(false)
  const [seen, setSeen] = useState(true)
  const [vis, setVis] = useState(typeof document === 'undefined' || !document.hidden)
  useEffect(() => { const f = () => setVis(!document.hidden); document.addEventListener('visibilitychange', f); return () => document.removeEventListener('visibilitychange', f) }, [])
  /* “正在回复”的头像只用 SVG 静帧 + CSS 呼吸（transform，合成层，不占主线程）；只有悬停和资料页大头像才跑逐帧动画 */
  const wantsLive = vis && (still === false || hover || (follow && size >= 56))
  const isStill = still === true || size < 22 || !wantsLive || !seen
  useEffect(() => {
    const el = host.current
    if (!el || !wantsLive || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver(([e]) => setSeen(e.isIntersecting))
    io.observe(el)
    return () => io.disconnect()
  }, [wantsLive])
  /* 只在形状变化时挂载一次；静止 / 活动之间切换走 update，不重建 SVG（重建会让悬停后第一下点击落空） */
  useEffect(() => {
    inst.current = mountAvatar(host.current!, { definition: defs[shape] ?? defs.chat, color, mood: isStill ? 'idle' : mood, followPointer: follow && !isStill, still: isStill, label: '' })
    return () => inst.current?.destroy()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shape])
  useEffect(() => {
    inst.current?.update({ color, mood: isStill ? 'idle' : mood, followPointer: follow && !isStill, still: isStill })
  }, [color, mood, follow, isStill])
  return <span ref={host} onPointerEnter={() => size >= 22 && setHover(true)} onPointerLeave={() => setHover(false)} className={cn('block', mood === 'thinking' && isStill && 'bob')} style={{ width: size, height: size }} />
}

export type Live = 'idle' | 'running' | 'waiting' | 'error'

/** 状态只来自真实事件：在跑 → 绿；等你 → 黄；出错 → 红 */
export function useLive(id: PersonId): Live {
  const { computes, pending } = useApp()
  const mine = Object.values(computes).filter((c) => c.owner === id)
  if (mine.some((c) => c.status === 'error')) return 'error'
  if (pending.some((p) => p.from === id)) return 'waiting'
  if (mine.some((c) => c.status === 'running')) return 'running'
  return 'idle'
}

export const liveDot: Record<Live, string> = { idle: '', running: 'bg-run', waiting: 'bg-warm-dot', error: 'bg-err' }

export function Avatar({ id, size = 32, mood, follow = false, className, status = false }: { id: PersonId; size?: number; mood?: Mood; follow?: boolean; className?: string; status?: boolean }) {
  const p = people[id]
  const live = useLive(id)
  const showDot = status && live !== 'idle' && size >= 24
  const d = Math.max(8, Math.round(size * 0.28))
  return (
    <span className={cn('relative inline-flex shrink-0', className)} style={{ width: size, height: size }} aria-label={p?.name}>
      {p?.shape ? (
        <Bot shape={p.shape} color={p.color!} size={size} mood={mood ?? 'idle'} follow={follow} />
      ) : (
        <span className="inline-flex h-full w-full select-none items-center justify-center rounded-full bg-fg font-semibold text-bg" style={{ fontSize: size * 0.38 }}>
          {p?.initials}
        </span>
      )}
      {showDot && <span className={cn('absolute bottom-0 right-0 rounded-full border-2 border-[hsl(var(--avatar-ring,var(--bg)))]', liveDot[live], live === 'running' && 'pulse-dot')} style={{ width: d, height: d }} />}
    </span>
  )
}

export function GroupAvatar({ ids, size = 40 }: { ids: PersonId[]; size?: number }) {
  const list = ids.filter((i) => i !== 'me').slice(0, 4)
  const s = Math.round(size * 0.5)
  const pos = [
    { left: 1, top: 1 },
    { right: 1, top: 1 },
    { left: 1, bottom: 1 },
    { right: 1, bottom: 1 },
  ]
  return (
    <span className="relative inline-block shrink-0 rounded-[32%] bg-hover" style={{ width: size, height: size }}>
      {list.map((id, i) => (
        <span key={id} className="absolute" style={pos[i]}>
          <Avatar id={id} size={s} mood="idle" status={false} />
        </span>
      ))}
    </span>
  )
}

export function AvatarStack({ ids, size = 20 }: { ids: PersonId[]; size?: number }) {
  return (
    <span className="inline-flex items-center">
      {ids.map((id, i) => (
        <span key={id} style={{ marginLeft: i ? -size * 0.2 : 0 }}>
          <Avatar id={id} size={size} mood="idle" status={false} />
        </span>
      ))}
    </span>
  )
}
