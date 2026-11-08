import { Check } from 'lucide-react'
import { motion, useReducedMotion } from 'motion/react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { TextArea } from '@/components/pages/kit/parts'
import { appear } from '@/components/pages/kit/motion'
import { ConfirmCard } from './parts'
import type { Draft, Grant } from './types'

/* 全局 Helper 的两张卡:读之前先问(授权卡,等你处理时用 warm),发之前先给草稿 */

export function GrantCard({ grant, onAnswer }: { grant: Grant; onAnswer: (yes: boolean) => void }) {
  const reduced = useReducedMotion()
  const asking = !grant.state
  return (
    <motion.div {...(reduced ? {} : appear)} className={cn('rounded-xl border px-3 py-3', asking ? 'border-warm/40 bg-warm-soft' : 'border-line bg-bg')}>
      <div className={cn('text-[13.5px]', asking && 'font-semibold')}>要读「{grant.title}」今天的 <span className="tabular-nums">{grant.n}</span> 条消息，可以吗？</div>
      <div className="mt-0.5 text-[12px] text-fg-2">只用于回答这个问题。读过之后会列在上面“能读”一栏，点 × 就移掉。</div>
      {grant.state ? (
        <div className="mt-2 flex items-center gap-1.5 text-[12.5px] text-fg-3"><Check className="h-3.5 w-3.5" />{grant.state === 'yes' ? '你允许了' : '你选了不读'}</div>
      ) : (
        <div className="mt-3 flex gap-2">
          <Button data-testid="hg-allow" variant="primary" onClick={() => onAnswer(true)} className="px-4">允许</Button>
          <Button data-testid="hg-deny" variant="outline" onClick={() => onAnswer(false)} className="px-4">不读</Button>
        </div>
      )}
    </motion.div>
  )
}

export function DraftCard({ draft, onBody, onSend, onCancel }: { draft: Draft; onBody: (v: string) => void; onSend: () => void; onCancel: () => void }) {
  const done = draft.state === 'sent' ? `已发到「${draft.title}」，消息上标着“由 Helper 代发”` : draft.state === 'cancel' ? '已取消，没有发' : undefined
  return (
    <ConfirmCard title="代发草稿" done={done}>
      <div className="grid grid-cols-[64px_1fr] items-baseline gap-y-1.5 text-[13px]">
        <span className="text-fg-3">发到</span><span className="min-w-0 truncate">「{draft.title}」</span>
        <span className="text-fg-3">身份</span><span>你（由 Helper 代发）</span>
        <span className="text-fg-3">正文</span>
        <TextArea data-testid="hg-draft-body" value={draft.body} disabled={!!draft.state} rows={2} onChange={(e) => onBody(e.target.value)} className="resize-none px-2 py-1" />
      </div>
      {!draft.state && (
        <div className="mt-3 flex gap-2">
          <Button data-testid="hg-send-confirm" variant="primary" onClick={onSend} disabled={!draft.body.trim()} className="px-4">发送</Button>
          <Button data-testid="hg-send-cancel" variant="outline" onClick={onCancel} className="px-4">取消</Button>
        </div>
      )}
    </ConfirmCard>
  )
}
