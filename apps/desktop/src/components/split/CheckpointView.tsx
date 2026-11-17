import { useState } from 'react'
import { History, Undo2 } from 'lucide-react'
import type { Compute } from '@/data'
import { useApp } from '@/ctx'
import { Button } from '@/components/ui/button'
import { Hint } from '@/components/pages/kit/parts'
import { CHECKPOINT_NOTE } from './constants'

/* 检查点:最新的在上;回到某个检查点要先确认,说清会恢复几个文件(破坏性操作要确认) */
export function CheckpointView({ c }: { c: Compute }) {
  const { rollback } = useApp()
  const [confirm, setConfirm] = useState<string | null>(null)
  return (
    <div data-testid="checkpoints">
      <Hint className="mb-3">{CHECKPOINT_NOTE}</Hint>
      {[...c.checkpoints].reverse().map((cp) => (
        <div key={cp.id} className="flex items-center gap-3 border-b border-line py-2.5 last:border-0">
          <History className="h-4 w-4 shrink-0 text-fg-3" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13.5px] font-medium">{cp.label}</div>
            <div className="text-[12px] tabular-nums text-fg-3">{cp.at} · 第 {cp.step + 1} 步后 · {cp.files} 个文件</div>
          </div>
          {confirm === cp.id ? (
            <div className="flex shrink-0 items-center gap-1.5">
              <span className="text-[12px] tabular-nums text-warm">之后改的 {Math.max(0, c.files.length - cp.files)} 个文件会恢复</span>
              <Button variant="ghost" size="xs" onClick={() => setConfirm(null)}>取消</Button>
              <Button variant="primary" size="xs" onClick={() => { rollback(c.id, cp.id); setConfirm(null) }}>确认回到这里</Button>
            </div>
          ) : (
            <Button variant="outline" size="xs" onClick={() => setConfirm(cp.id)} className="text-fg-2 hover:text-fg"><Undo2 />回到这里</Button>
          )}
        </div>
      ))}
    </div>
  )
}
