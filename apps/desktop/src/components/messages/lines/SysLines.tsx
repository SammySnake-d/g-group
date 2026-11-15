/* 居中的灰字行:日期、系统提示、助手之间的讨论、联系人记下的承诺、资产提示。不占气泡,点了在分栏或浮层里看 */
import { ChevronRight, KeyRound, Pin } from 'lucide-react'
import { cn } from '@/lib/utils'
import { people } from '@/data'
import { useApp } from '@/ctx'
import { live } from '@/api/wire/live'
import { useAppStore } from '@/store'
import { AvatarStack } from '@/components/Avatar'
import { Pressable, TextLink } from '../Pressable'
import type { MsgOf } from '../types'

/** 居中灰字行的可点外形:悬停才出底色,文字变深一档 */
const PILL = 'gap-1.5 rounded-full px-3 py-1 text-[12.5px] text-fg-3 hover:bg-hover hover:text-fg-2'

export function DateLine({ text }: { text: string }) {
  return <div className="select-none py-3 text-center text-xs tabular-nums text-fg-3">{text}</div>
}

export function SysLine({ m }: { m: MsgOf<'sys'> }) {
  const { reedit, unrewind } = useApp()
  /* 连上后端时宿主没有「恢复回退」(恢复范围待拍板,AC-48):不放一个点了也做不成的链接 */
  const canRestore = !useAppStore((s) => live(s))
  return (
    <div data-msg={m.id} data-testid={m.rewind ? 'rewind-line' : m.recalled !== undefined || /撤回了一条消息/.test(m.text) ? 'recall-line' : undefined} className="py-1.5 text-center text-xs text-fg-3">
      {m.text}
      {m.rewind && canRestore && <TextLink data-testid={`rewind-undo-${m.id}`} onClick={() => unrewind(m.id)} className="ml-1.5">恢复</TextLink>}
      {m.recalled && <TextLink data-testid={`reedit-${m.id}`} onClick={() => reedit(m.recalled!)} className="ml-1.5">重新编辑</TextLink>}
    </div>
  )
}

/* 助手之间的讨论:GrokBot 式一行灰字,点开在右侧只读看原话 */
export function HuddleLine({ m, conv }: { m: MsgOf<'huddle'>; conv: string }) {
  const { push } = useApp()
  return (
    <div className="my-1.5 flex justify-center" data-msg={m.id}>
      <Pressable data-testid={`huddle-${m.id}`} onClick={() => push({ t: 'huddle', conv, msgId: m.id }, true)} className={cn(PILL, 'group/h')}>
        <span className="tabular-nums">{m.items.length} 条消息 ·</span>
        <AvatarStack ids={m.who} size={16} />
        <span>{m.who.map((w) => people[w].name).join(' 和 ')}</span>
        <ChevronRight className="h-3.5 w-3.5 opacity-60 transition-transform duration-fast ease-out group-hover/h:translate-x-0.5" />
      </Pressable>
    </div>
  )
}

/* US11 / US6:联系人把一句话记成了自己的承诺 */
export function CommitLine({ m }: { m: MsgOf<'commit'> }) {
  const { commits, push, active } = useApp()
  const list = commits.filter((c) => m.ids.includes(c.id))
  const off = list.every((c) => !c.on)
  return (
    <div className="my-1.5 flex justify-center" data-msg={m.id}>
      <Pressable data-testid={`commit-${m.id}`} onClick={() => push({ t: 'commits', id: active }, true)} className={PILL}>
        <Pin className="h-3.5 w-3.5" />
        <AvatarStack ids={list.map((c) => c.owner)} size={16} />
        <span data-testid={`commit-state-${m.id}`} data-off={off ? '1' : undefined} className={cn(off && 'line-through decoration-fg-3/50')}>{list.map((c) => people[c.owner].name).join('、')} 记下了：{list[0]?.trigger === '定时' ? list[0].text : '有进度就在群里 @你'}</span>
        {off && <span className="text-fg-3">· 你撤回了原话，已停</span>}
        <ChevronRight className="h-3.5 w-3.5 opacity-60" />
      </Pressable>
    </div>
  )
}

/* US3:资产提示,和普通消息视觉区分(虚线框) */
export function AssetLine({ m }: { m: MsgOf<'asset'> }) {
  const { openSplit } = useApp()
  return (
    <div className="my-2 flex justify-center" data-msg={m.id}>
      <Pressable data-testid={`asset-${m.id}`} onClick={() => openSplit({ t: 'artifact', id: m.assetId })} className="max-w-[90%] shrink gap-2 rounded-xl border border-dashed border-fg-3/40 bg-side px-3 py-1.5 text-[12.5px] text-fg-2 hover:border-fg-3/70 hover:text-fg">
        <KeyRound className="h-3.5 w-3.5" />
        <span className="truncate">{m.text}</span>
        <span className="shrink-0 font-medium text-fg">查看</span>
      </Pressable>
    </div>
  )
}
