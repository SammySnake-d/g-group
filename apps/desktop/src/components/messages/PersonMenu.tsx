/* 点头像:查看资料 / 从群聊私信(只在群里)/ 私聊 / @它 */
import type { ReactNode } from 'react'
import { Activity, AtSign, IdCard, MessageSquare } from 'lucide-react'
import { dutyByConv, people, type PersonId } from '@/data'
import { useApp } from '@/ctx'
import { Avatar, useLive } from '@/components/Avatar'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { LIVE_TEXT } from './copy'

export function PersonMenu({ id, children, side = 'top' }: { id: PersonId; children: ReactNode; side?: 'top' | 'left' | 'right' | 'bottom' }) {
  const { push, openDm, mention, convs, active, poke, silence, openWorkbench, openContact } = useApp()
  /* 禁言的语义还没定(需求 U03「禁言与停止执行是否同一件事待定」),连上后端时不放这个入口 */
  const isLive = useApp((s) => s.backend.mode === 'connected')
  const p = people[id]
  const live = useLive(id)
  const conv = convs.find((c) => c.id === active)
  const silenced = !!conv?.silenced?.[id]
  if (id === 'me' || !p) return <>{children}</>
  const inGroup = conv?.kind === 'group' && !p.human
  const duty = conv && dutyByConv[conv.id]?.[id]
  const actions = [
    { t: 'menu-at', l: '@它', I: AtSign, run: () => mention(id), show: true },
    { t: 'menu-dm', l: '私聊', I: MessageSquare, run: () => openDm(id), show: !p.human },
    { t: 'menu-process', l: '看过程', I: Activity, run: () => openContact(id, active, 'process'), show: !p.human },
    { t: 'menu-split', l: '资料', I: IdCard, run: () => openContact(id, active), show: !p.human },
  ].filter((x) => x.show)
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
      <DropdownMenuContent align="start" side={side} sideOffset={6} className="w-64 rounded-2xl border-line bg-elev p-1.5 shadow-elev" data-testid="person-menu">
        <div className="flex items-center gap-3 px-2 pb-2.5 pt-1.5">
          <Avatar id={id} size={40} />
          <div className="min-w-0">
            <div className="truncate text-[14px] font-semibold">{p.name}</div>
            <div className="truncate text-[12px] text-fg-2">{duty ? `本群分工：${duty}` : p.role} · {LIVE_TEXT[live]}</div>
          </div>
        </div>
        <div className="grid grid-cols-4 gap-1 px-1 pb-1">
          {actions.map((x) => (
            <DropdownMenuItem key={x.t} data-testid={x.t} onSelect={x.run} className="flex flex-col items-center gap-1 rounded-lg px-1 py-2 text-[12px] text-fg-2 focus:text-fg">
              <x.I className="h-[18px] w-[18px]" strokeWidth={1.7} />{x.l}
            </DropdownMenuItem>
          ))}
        </div>
        {!p.human && (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger data-testid="menu-more" className="rounded-lg text-[13px] text-fg-2">更多</DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-52 rounded-xl border-line bg-elev p-1 shadow-elev">
              <DropdownMenuItem data-testid="menu-detail" className="rounded-lg" onSelect={() => openContact(id, active, 'talks')}>它和别的助手说了什么</DropdownMenuItem>
              {inGroup && <DropdownMenuItem data-testid="menu-inner" className="rounded-lg" onSelect={() => push({ t: 'inner', id, conv: active }, true)}>从群聊私信</DropdownMenuItem>}
              <DropdownMenuItem data-testid="menu-workbench" className="rounded-lg" onSelect={() => openWorkbench(id)}>去工作台管理</DropdownMenuItem>
              {inGroup && <DropdownMenuItem data-testid="menu-poke" className="rounded-lg" onSelect={() => poke(id)}>拍一拍</DropdownMenuItem>}
              {inGroup && !isLive && <DropdownMenuItem data-testid="menu-silence" className="rounded-lg" onSelect={() => silence(active, id)}>{silenced ? '解除禁言' : '禁言 30 分钟'}</DropdownMenuItem>}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
