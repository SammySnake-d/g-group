import { MessageCircle, RotateCw, UserPlus, Users } from 'lucide-react'
import { rewire } from '@/api/wire'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/section'
import { useApp } from '@/store'

/* 还没有任何会话时的聊天区(连上后端的第一次打开最常见):说清为什么空、下一步做什么。
   正在读 → 只说在读;会话没读到 → 原因 + 重读;真的没有 → 有联系人就去通讯录找它,没有就先添加联系人 */
export function ChatEmpty() {
  const { backend, wire, hasContacts, push, setSection } = useApp((s) => ({ backend: s.backend.mode, wire: s.wire, hasContacts: s.contactIds.length > 0, push: s.push, setSection: s.setSection }))
  const lost = wire.phase === 'live' ? wire.failed.find((f) => f.entity === '会话') : undefined
  const reading = backend === 'checking' || (backend === 'connected' && wire.phase !== 'live')
  return (
    <main className="grid min-w-[520px] flex-1 place-items-center bg-bg" data-testid="chat-empty" data-state={reading ? 'reading' : lost ? 'failed' : 'empty'}>
      {reading ? <EmptyState icon={<MessageCircle />} title="正在读取会话…" />
        : lost ? <EmptyState icon={<MessageCircle />} title="会话没读到" hint={lost.reason}
          action={<Button variant="secondary" size="sm" className="mt-2" onClick={rewire}><RotateCw />重新读取</Button>} />
        : hasContacts ? <EmptyState icon={<MessageCircle />} title="还没有对话" hint="在通讯录里选一位联系人，给它发消息。"
          action={<Button variant="primary" size="sm" className="mt-2" onClick={() => setSection('contacts')}><Users />去通讯录</Button>} />
        : <EmptyState icon={<MessageCircle />} title="还没有对话" hint="先添加一个联系人，就能和它私聊、交代事情。"
          action={<Button variant="primary" size="sm" className="mt-2" onClick={() => push({ t: 'addContact' }, true)}><UserPlus />添加联系人</Button>} />}
    </main>
  )
}
