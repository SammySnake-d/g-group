import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Bot } from '@/components/Avatar'
import { computes0, convs0, people } from '@/data'
import { cn } from '@/lib/utils'
import { ComputeCard } from './ComputeCard'
import { HarnessSession } from './HarnessSession'
import { DEMO_NOW, demoSession } from './demo-sessions'

/* 开发预览(?preview=compute&id=<computeId>)：只渲染 Compute 卡 + harness 会话窗口，不起整个应用，
   给 e2e 和截图用。左边是一条「联系人分出 Compute」的消息，右边是点「打开会话」后的会话窗口（和分屏同宽）。
   接进应用以后（消息流、完整过程面板、分屏页签）这个文件可以删掉。 */

const PREVIEW_COPY = {
  heading: 'Compute 卡与 harness 会话 · 预览',
  said: '好，我分一个 Compute 去做。',
  talked: '接线后：回到派活的群或私聊，引用派活消息并 @ 它',
  noop: '接线后由消息流提供',
  dmTitle: (who: string) => `与 ${who} 私聊`,
} as const

export function ComputePreview({ id }: { id: string }) {
  const c = computes0[id] ?? computes0.login!
  const owner = people[c.owner]
  const transcript = demoSession(c.id)
  const [open, setOpen] = useState(false)
  const [note, setNote] = useState('')
  const conv = convs0.find((x) => x.id === c.conv)
  const dm = conv?.kind === 'dm'
  const sourceTitle = conv ? (dm ? PREVIEW_COPY.dmTitle(conv.title) : conv.title) : c.conv
  const noop = () => setNote(PREVIEW_COPY.noop)
  return (
    <TooltipProvider delayDuration={500} skipDelayDuration={300}>
      <div className="flex h-full min-h-0 bg-bg text-fg" data-testid="compute-preview">
        <main className="flex min-w-0 flex-1 flex-col">
          <nav className="flex shrink-0 flex-wrap items-center gap-1 border-b border-line px-4 py-2" aria-label={PREVIEW_COPY.heading}>
            <span className="mr-2 text-[12.5px] font-semibold">{PREVIEW_COPY.heading}</span>
            {Object.values(computes0).map((x) => (
              <Button key={x.id} asChild variant="ghost" size="xs" className={cn('font-code text-[11.5px]', x.id === c.id && 'bg-sel text-fg')}>
                <a href={`?preview=compute&id=${x.id}${document.documentElement.classList.contains('dark') ? '&theme=dark' : ''}`}>{x.id}</a>
              </Button>
            ))}
            {note && <span className="ml-auto text-[12px] text-fg-3" data-testid="preview-note">{note}</span>}
          </nav>
          <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
            <div className="mx-auto flex w-full max-w-[680px] gap-3 px-6 py-8">
              {owner?.shape && owner.color ? <Bot shape={owner.shape} color={owner.color} size={36} still /> : null}
              <div className="min-w-0 flex-1 space-y-1.5">
                <div className="text-[12.5px] text-fg-2"><span className="font-medium text-fg">{owner?.name}</span></div>
                <div className="w-fit rounded-2xl rounded-tl-md bg-theirs px-3.5 py-2 text-[14px] shadow-soft">{PREVIEW_COPY.said}</div>
                <ComputeCard compute={c} transcript={transcript} now={DEMO_NOW} onOpenSession={() => setOpen(true)} actions={{ retry: noop, switchModel: noop, skip: noop }} />
              </div>
            </div>
          </div>
        </main>
        {open && (
          <aside className="flex w-[min(560px,46vw)] shrink-0 border-l border-line" data-testid="preview-session-pane">
            <HarnessSession
              compute={c}
              transcript={transcript}
              sourceTitle={sourceTitle}
              dm={dm}
              now={DEMO_NOW}
              autoFocus
              onBack={() => setOpen(false)}
              onClose={() => setOpen(false)}
              onJumpSource={noop}
              onTalk={() => setNote(PREVIEW_COPY.talked)}
            />
          </aside>
        )}
      </div>
    </TooltipProvider>
  )
}
