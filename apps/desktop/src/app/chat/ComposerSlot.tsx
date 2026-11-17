import { Composer } from '@/components/Composer'
import type { Conversation, QuoteRef } from '@/data'
import { broken } from '@/mut'
import { useApp } from '@/store'
import { composerInput } from '@/store/dom'
import { draftOf } from '@/store/select'

const NONE: QuoteRef[] = []

/** 阅读栏底部的输入框:和消息栏同宽、居中 */
export function ComposerSlot({ conv }: { conv: Conversation }) {
  const { draft, quotes, setDraft, send, removeQuote } = useApp((s) => ({ draft: draftOf(s, broken('AC-24')), quotes: s.quotes[s.active] ?? NONE, setDraft: s.setDraft, send: s.send, removeQuote: s.removeQuote }))
  return (
    <div className="mx-auto w-full max-w-[var(--chat-col)] shrink-0 px-6" data-testid="composer-column">
      <Composer conv={conv} draft={draft} setDraft={setDraft} quotes={quotes} inputRef={composerInput} onSend={send} onRemoveQuote={removeQuote} />
    </div>
  )
}
