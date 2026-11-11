/* 卸载二次确认:先把后果一条条摆出来(摘下哪些聊天、谁不能再调用、哪些命令失效、收回几项权限),确认才卸。 */
import type { ReactNode } from 'react'
import { ShieldOff, SquareSlash, Trash2, Unplug, UserX } from 'lucide-react'
import { useApp } from '@/ctx'
import { Button } from '@/components/ui/button'
import { Modal, ModalBody, ModalFooter, useExitValue } from '@/components/ui/modal'
import { COPY } from './constants'
import { PluginIcon } from './tags'
import { convName, personName } from './util'

function Line({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return <li className="flex items-start gap-2.5 py-1.5"><span className="mt-0.5 shrink-0 text-fg-3 [&_svg]:h-3.5 [&_svg]:w-3.5">{icon}</span><span className="min-w-0 flex-1">{children}</span></li>
}

export function UninstallDialog({ id: live, onClose }: { id: string | null; onClose: () => void }) {
  const { plugins, convs, pluginAct, toast } = useApp()
  const id = useExitValue(live)
  const s = id ? plugins.find((p) => p.id === id) : undefined
  const m = useExitValue(s?.manifest)
  if (!id || !m) return null
  const go = () => { const r = pluginAct(id, { type: 'uninstall' }); if (!r.ok) toast(r.error); onClose() }
  return (
    <Modal open={!!live && !!s?.manifest} onClose={onClose} testid="plg-uninstall-confirm" width={460} icon={<PluginIcon m={m} size={40} />} title={`卸载「${m.name}」？`} description={COPY.uninstallDesc}>
      {s && (
        <ModalBody>
          <ul className="divide-y divide-line rounded-xl border border-line px-3.5 text-[13px] text-fg-2">
            <Line icon={<Unplug />}>{s.convs.length ? <>从 <span className="tabular-nums">{s.convs.length}</span> 个聊天摘下：{s.convs.map((c) => convName(convs, c)).join('、')}</> : '没挂在任何聊天上'}</Line>
            {s.callers.length > 0 && <Line icon={<UserX />}>{s.callers.map(personName).join('、')} 不能再调用它</Line>}
            {m.contributes.commands.length > 0 && <Line icon={<SquareSlash />}>这些命令不能再用：<span className="font-code text-fg">{m.contributes.commands.map((c) => `/${c.name}`).join('  ')}</span></Line>}
            {s.granted.length > 0 && <Line icon={<ShieldOff />}>已同意的 <span className="tabular-nums">{s.granted.length}</span> 项权限一并收回</Line>}
          </ul>
        </ModalBody>
      )}
      <ModalFooter>
        <span className="flex-1" />
        <Button data-testid="plg-uninstall-cancel" variant="ghost" onClick={onClose}>取消</Button>
        <Button data-testid="plg-uninstall-yes" variant="danger-solid" onClick={go}><Trash2 />卸载</Button>
      </ModalFooter>
    </Modal>
  )
}
