import * as D from '@animate-ui/react/primitives/radix-ui/dialog'
import { Button } from '@/components/ui/button'
import { useApp } from '@/store'

/** AC-48 私聊回退前确认:写明会撤下几条、哪些一起作废,撤下后可恢复 */
export function RewindDialog() {
  const { ask, active, convs, setAsk, rewind } = useApp((s) => ({ ask: s.rewindAsk, active: s.active, convs: s.convs, setAsk: s.setRewindAsk, rewind: s.rewind }))
  const c = convs.find((x) => x.id === active)
  const i = ask && c ? c.messages.findIndex((m) => 'id' in m && m.id === ask) : -1
  const n = i < 0 || !c ? 0 : c.messages.slice(i + 1).filter((m) => m.k !== 'date').length
  return (
    <D.Root open={!!ask} onOpenChange={(v) => { if (!v) setAsk(null) }}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-50 bg-black/30" />
        <D.Content data-testid="rewind-dialog" className="fixed inset-0 z-50 m-auto h-fit w-[340px] rounded-2xl bg-elev p-4 text-fg shadow-elev outline-none">
          <D.Title className="text-[15px] font-semibold">回到这条消息？</D.Title>
          <D.Description className="mt-1.5 text-[13px] leading-relaxed text-fg-2">之后的 <span className="tabular-nums">{n}</span> 条会撤下，它们里等你回答的问题一起作废，对方从这里接着聊。已经做完的事撤不回。撤下后随时可以恢复。</D.Description>
          <div className="mt-3 flex gap-2">
            <D.Close asChild><Button variant="secondary" size="md" className="flex-1">取消</Button></D.Close>
            <Button data-testid="rewind-confirm" variant="primary" size="md" className="flex-1" onClick={() => ask && rewind(active, ask)}>回到这里</Button>
          </div>
        </D.Content>
      </D.Portal>
    </D.Root>
  )
}
