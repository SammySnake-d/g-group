/* 删除定时要二次确认:写清删的是哪一个、连带删掉什么,并提示「只想停一阵子用暂停」。Esc 只关这张确认框,不收分屏 */
import { people, type Cron } from '@/data'
import { cronRule } from '@/cronView'
import { Button } from '@/components/ui/button'
import { Modal, ModalBody, ModalFooter } from '@/components/ui/modal'
import { DELETE } from './constants'

export function DeleteCronDialog({ c, open, onClose, onConfirm }: { c: Cron; open: boolean; onClose: () => void; onConfirm: () => void }) {
  const owner = people[c.owner]?.name
  return (
    <Modal open={open} onClose={onClose} testid="cron-delete-confirm" width={420} title={DELETE.title} onEscapeKeyDown={(e) => e.stopPropagation()}>
      <ModalBody className="pt-2">
        <div className="rounded-lg border border-line bg-side px-3 py-2.5 text-[13px] leading-snug">
          <div className="line-clamp-3 whitespace-pre-line">{c.text}</div>
          <div className="mt-1 truncate text-[12px] text-fg-3">{owner} · {cronRule(c)}</div>
        </div>
        <p className="mt-2.5 text-[12.5px] leading-relaxed text-fg-2">
          {owner} 之后不会再按它醒来，<span className="tabular-nums">{c.runs.length}</span> 次运行历史也一起删掉。只想停一阵子，用「暂停」就行。
        </p>
      </ModalBody>
      <ModalFooter className="justify-end">
        <Button data-testid="cron-delete-cancel" variant="ghost" size="md" onClick={onClose}>{DELETE.cancel}</Button>
        <Button data-testid="cron-delete-ok" variant="danger-solid" size="md" onClick={onConfirm}>{DELETE.ok}</Button>
      </ModalFooter>
    </Modal>
  )
}
