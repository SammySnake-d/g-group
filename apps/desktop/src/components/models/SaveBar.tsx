import { Undo2 } from 'lucide-react'
import type { ContactModels, NextTurn } from '@g-group/ui-core'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import type { ModelSettings } from '@/modelConfig'
import { CM } from './constants'
import { NextTurnNote } from './NextTurnNote'

/** 联系人模型卡底部:有改动时说清能不能存、为什么不能;存过后换成「下一轮生效」的说明 */
export function SaveBar({ dirty, allowed, stallErr, canSave, notice, s, cm, name, running, onRevert, onSave }: {
  dirty: boolean
  allowed: boolean
  stallErr: boolean
  canSave: boolean
  notice: NextTurn | null
  s: ModelSettings
  cm: ContactModels
  name: string
  running: string[]
  onRevert: () => void
  onSave: () => void
}) {
  const blocked = !allowed || stallErr
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line pt-3">
      {dirty ? (
        <>
          <span data-testid="cm-save-hint" role={blocked ? 'alert' : undefined} className={cn('flex flex-1 items-center gap-1.5 text-[12.5px]', blocked ? 'text-err' : 'text-fg-2')}>
            <span aria-hidden className={cn('h-1.5 w-1.5 shrink-0 rounded-full', blocked ? 'bg-err' : 'bg-warm-dot')} />
            {!allowed ? CM.hintBlocked : stallErr ? CM.hintStall : CM.hintDirty}
          </span>
          <Button data-testid="cm-revert" variant="ghost" size="sm" onClick={onRevert}><Undo2 aria-hidden />{CM.revert}</Button>
          <Button data-testid="cm-save" variant="primary" size="sm" className="px-4" disabled={!canSave} onClick={onSave}>{CM.save}</Button>
        </>
      ) : notice && <NextTurnNote n={notice} s={s} c={cm} name={name} running={running} />}
    </div>
  )
}
