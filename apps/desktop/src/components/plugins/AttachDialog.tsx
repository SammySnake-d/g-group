/* 装好的那一刻接着问:挂到哪些聊天、哪些助手能调用。装了不挂不生效,所以就地给出下一步。 */
import { useState } from 'react'
import { Check } from 'lucide-react'
import { useApp } from '@/ctx'
import { Avatar, GroupAvatar } from '@/components/Avatar'
import { Button } from '@/components/ui/button'
import { Modal, ModalBody, ModalFooter, useExitValue } from '@/components/ui/modal'
import { cn } from '@/lib/utils'
import { COPY } from './constants'
import { assistants, convName, groupsFirst, toggleIn } from './util'

export function AttachDialog({ id: live, onClose }: { id: string | null; onClose: () => void }) {
  const { plugins } = useApp()
  const id = useExitValue(live)
  const m = useExitValue(id ? plugins.find((p) => p.id === id)?.manifest : null)
  if (!id || !m) return null
  return (
    <Modal open={!!live} onClose={onClose} testid="plg-attach-after" width={500} title={`「${m.name}」装好了，挂到哪个聊天？`} description={COPY.attachDesc}
      icon={<span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-run-soft text-ok"><Check className="h-5 w-5" strokeWidth={2.5} /></span>}>
      <AttachBody id={id} onClose={onClose} />
    </Modal>
  )
}

function AttachBody({ id, onClose }: { id: string; onClose: () => void }) {
  const { convs, pluginAct } = useApp()
  const [pick, setPick] = useState<Set<string>>(new Set())
  const [who, setWho] = useState<Set<string>>(new Set())
  const done = () => {
    for (const c of pick) pluginAct(id, { type: 'attach', conv: c })
    for (const w of who) pluginAct(id, { type: 'allow', caller: w })
    onClose()
  }
  return (
    <>
      <ModalBody className="px-4">
        <div className="max-h-[300px] space-y-0.5 overflow-y-auto">
          {[...convs].sort(groupsFirst).map((c) => {
            const on = pick.has(c.id)
            const peer = c.kind === 'dm' ? c.members.find((x) => x !== 'me') : undefined
            return (
              <Button key={c.id} data-testid={`plg-attach-after-${c.id}`} aria-pressed={on} variant="ghost" size={null} onClick={() => setPick((p) => toggleIn(p, c.id))}
                className={cn('h-auto w-full justify-start gap-3 rounded-xl px-2 py-2 text-left font-normal text-fg active:scale-100', on && 'bg-sel hover:bg-sel')}>
                {peer ? <Avatar id={peer} size={30} status={false} /> : <GroupAvatar ids={c.members} size={30} />}
                <span className="min-w-0 flex-1 truncate text-[13.5px]">{convName(convs, c.id)}</span>
                <span aria-hidden className={cn('grid h-5 w-5 place-items-center rounded-full border transition-[background-color,border-color] duration-fast', on ? 'border-me bg-me text-me-fg' : 'border-fg-3/50')}>{on && <Check className="h-3 w-3" strokeWidth={3} />}</span>
              </Button>
            )
          })}
        </div>
        <div className="mt-3 px-2">
          <div className="mb-1.5 text-[12.5px] font-medium text-fg-2">哪些助手能调用</div>
          <div className="flex flex-wrap gap-1.5">
            {assistants().map((a) => {
              const on = who.has(a.id)
              return (
                <Button key={a.id} data-testid={`plg-attach-who-${a.id}`} aria-pressed={on} variant="outline" size={null} shape="pill" onClick={() => setWho((w) => toggleIn(w, a.id))}
                  className={cn('h-7 gap-1.5 pl-1 pr-2.5 text-[12.5px] font-normal shadow-none', on ? 'border-me/50 bg-me/10 text-fg hover:bg-me/15' : 'text-fg-2')}>
                  <Avatar id={a.id} size={18} status={false} />{a.name}
                </Button>
              )
            })}
          </div>
        </div>
      </ModalBody>
      <ModalFooter>
        <span className="min-w-0 truncate text-[12.5px] tabular-nums text-fg-3">{pick.size ? `挂到 ${pick.size} 个聊天` : '还没选聊天'}{who.size ? ` · ${who.size} 位助手能调用` : ''}</span>
        <span className="flex-1" />
        <Button data-testid="plg-attach-after-skip" variant="ghost" onClick={onClose}>先不挂</Button>
        <Button data-testid="plg-attach-after-done" variant="primary" disabled={pick.size === 0} onClick={done}>挂上</Button>
      </ModalFooter>
    </>
  )
}
