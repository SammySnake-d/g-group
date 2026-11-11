import { useEffect, useState } from 'react'
import * as D from '@animate-ui/react/primitives/radix-ui/dialog'
import type { RewindPreview } from '@g-group/api-contract'
import { rewindPreviewLive } from '@/api/wire/chat-ops'
import { live, liveCtx } from '@/api/wire/live'
import { Button } from '@/components/ui/button'
import { useApp, useAppStore } from '@/store'

/** 连上后端:打开时向宿主要回退预览(只读),写明真实会撤下几条、取消哪些在途任务、作废几条承诺、哪些已经发生撤不回 */
function useLivePreview(ask: string | null, active: string, on: boolean): RewindPreview | string | null {
  const [p, setP] = useState<RewindPreview | string | null>(null)
  useEffect(() => {
    setP(null)
    if (!on || !ask) return
    let gone = false
    const s = useAppStore
    void rewindPreviewLive(liveCtx(s.getState, s.setState), active, ask).then((r) => { if (!gone) setP(r) })
    return () => { gone = true }
  }, [ask, active, on])
  return p
}

/** 预览 → 对话框里那段话:只说会发生什么,撤不回的如实说 */
function liveText(p: RewindPreview): string {
  const parts = [`之后的 ${p.messages.length} 条会撤下，对方从这里接着聊，撤下的不再算数`]
  if (p.tasks.length) parts.push(`由它们派出的 ${p.tasks.length} 件事会停下（${p.tasks.map((t) => `「${t.title}」`).join('')}）`)
  if (p.commitments.length) parts.push(`${p.commitments.length} 条由它们记下的承诺作废`)
  if (p.sideEffects.length) parts.push(`已经做了的 ${p.sideEffects.length} 件事撤不回`)
  return parts.join('；') + '。'
}

/** AC-48 私聊回退前确认:写明会撤下几条、哪些一起作废;演示数据撤下后可恢复 */
export function RewindDialog() {
  const { ask, active, convs, setAsk, rewind, isLive } = useApp((s) => ({ ask: s.rewindAsk, active: s.active, convs: s.convs, setAsk: s.setRewindAsk, rewind: s.rewind, isLive: live(s) }))
  const c = convs.find((x) => x.id === active)
  const i = ask && c ? c.messages.findIndex((m) => 'id' in m && m.id === ask) : -1
  const n = i < 0 || !c ? 0 : c.messages.slice(i + 1).filter((m) => m.k !== 'date').length
  const p = useLivePreview(ask, active, isLive)
  const ready = !isLive || (p !== null && typeof p !== 'string')
  const empty = isLive && p !== null && typeof p !== 'string' && !p.messages.length
  return (
    <D.Root open={!!ask} onOpenChange={(v) => { if (!v) setAsk(null) }}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-50 bg-black/30" />
        <D.Content data-testid="rewind-dialog" className="fixed inset-0 z-50 m-auto h-fit w-[340px] rounded-2xl bg-elev p-4 text-fg shadow-elev outline-none">
          <D.Title className="text-[15px] font-semibold">回到这条消息？</D.Title>
          {isLive ? (
            <D.Description data-testid="rewind-preview" className="mt-1.5 text-[13px] leading-relaxed text-fg-2">
              {p === null ? '正在算会撤下哪些…' : typeof p === 'string' ? `算不出来：${p}` : empty ? '这已经是最后一条了，没有可以撤下的。' : liveText(p)}
            </D.Description>
          ) : (
            <D.Description className="mt-1.5 text-[13px] leading-relaxed text-fg-2">之后的 <span className="tabular-nums">{n}</span> 条会撤下，它们里等你回答的问题一起作废，对方从这里接着聊。已经做完的事撤不回。撤下后随时可以恢复。</D.Description>
          )}
          <div className="mt-3 flex gap-2">
            <D.Close asChild><Button variant="secondary" size="md" className="flex-1">取消</Button></D.Close>
            <Button data-testid="rewind-confirm" variant="primary" size="md" className="flex-1" disabled={!ready || empty} onClick={() => ask && rewind(active, ask)}>回到这里</Button>
          </div>
        </D.Content>
      </D.Portal>
    </D.Root>
  )
}
