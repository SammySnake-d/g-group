import { BellOff, Link2, PanelRight, Search, Settings2 } from 'lucide-react'
import { Bot } from '@/components/Avatar'
import { MemberStack } from '@/components/GroupSide'
import { PersonMenu } from '@/components/Messages'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/icon-button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { HELPER_MARK } from '@/config/brand'
import { people, type Conversation } from '@/data'
import { broken } from '@/mut'
import { useApp } from '@/store'

const titleBtn = 'h-auto min-w-0 justify-start gap-1.5 py-1 pl-1 pr-2 text-fg'

/** 聊天头部:标题(群点开群资料、私聊点开对方菜单)、关联会话、Helper、查找、成员、群资料、设置 */
export function ChatHeader({ conv }: { conv: Conversation }) {
  const { convs, helperPanel, setHelperPanel, push, openSplit, sideOpen } = useApp((s) => ({ convs: s.convs, helperPanel: s.helperPanel, setHelperPanel: s.setHelperPanel, push: s.push, openSplit: s.openSplit, sideOpen: s.tabs[s.tabIdx]?.t === 'group' }))
  const peer = conv.kind === 'dm' ? conv.members.find((m) => m !== 'me')! : null
  const links = (conv.links ?? []).map((l) => convs.find((c) => c.id === l)).filter(Boolean) as Conversation[]
  return (
    <header className="flex h-[52px] shrink-0 items-center gap-2 border-b border-line pl-5 pr-3">
      {peer ? (
        <PersonMenu id={peer} side="bottom">
          <Button variant="ghost" size={null} className={titleBtn}><span className="truncate text-[15px] font-semibold">{conv.title}</span><span className="text-[12px] font-normal text-fg-3">{people[peer].role}</span></Button>
        </PersonMenu>
      ) : (
        <Button variant="ghost" size={null} data-testid="chat-title" onClick={() => (broken('AC-50-3') ? push({ t: 'group', id: conv.id }, true) : openSplit({ t: 'group', id: conv.id }))} className={titleBtn}>
          <span className="truncate text-[15px] font-semibold">{conv.title}</span>
          <span className="shrink-0 text-[13px] font-normal tabular-nums text-fg-3">({conv.members.length})</span>
          {conv.muted && <BellOff className="h-3.5 w-3.5 text-fg-3" />}
        </Button>
      )}
      {links.length > 0 && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button data-testid="chat-links" variant="secondary" size="xs" shape="pill" onClick={() => push({ t: 'links', id: conv.id }, true)} className="text-fg-2 hover:text-fg"><Link2 />关联 {links.length}</Button>
          </TooltipTrigger>
          <TooltipContent>{`关联了：${links.map((l) => l.title).join('、')}`}</TooltipContent>
        </Tooltip>
      )}
      <div className="flex-1" />
      <IconButton data-testid="head-helper" label="Helper（只读这个聊天，只有你看得到）" active={helperPanel} onClick={() => setHelperPanel(!helperPanel)} icon={<Bot shape={HELPER_MARK.shape} color={HELPER_MARK.color} size={20} />} />
      <IconButton data-testid="head-search" label="查找聊天记录" onClick={() => push({ t: 'search', id: conv.id }, true)} icon={<Search strokeWidth={1.6} />} />
      {conv.kind === 'group' ? (
        <>
          <MemberStack conv={conv} onOpen={() => openSplit({ t: 'group', id: conv.id, tab: 'members' })} />
          <IconButton data-testid="head-side" label="群资料：成员、公告、清单、定时、插件、工具" active={sideOpen} onClick={() => openSplit({ t: 'group', id: conv.id })} icon={<PanelRight strokeWidth={1.6} />} />
          <IconButton data-testid="chat-more" label="群设置（改名、置顶、免打扰、退出）" onClick={() => push({ t: 'group', id: conv.id }, true)} icon={<Settings2 strokeWidth={1.6} />} />
        </>
      ) : (
        <IconButton data-testid="chat-more" label="聊天设置" onClick={() => push({ t: 'person', id: peer! }, true)} icon={<Settings2 strokeWidth={1.6} />} />
      )}
    </header>
  )
}
