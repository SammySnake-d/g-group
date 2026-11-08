import { useState } from 'react'
import { MessageSquarePlus } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { CFile } from '@/data'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/icon-button'
import { TextInput } from '@/components/pages/kit/parts'

/* 改动:逐文件 diff,行上可以留评论,然后让它按评论改。左边文件名只显示最后一段(悬停看全路径),
   增删行数等宽对齐;新增行 run-soft 底、删除行 err-soft 底,符号列 +/− 同色。 */
export function DiffView({ files, onAsk }: { files: CFile[]; onAsk: (t: string) => void }) {
  const [sel, setSel] = useState(0)
  const [comments, setComments] = useState<Record<string, string>>({})
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const f = files[sel]
  const n = Object.keys(comments).length
  return (
    <div className="flex h-full min-h-[360px] gap-4" data-testid="diff">
      <div className="w-[180px] shrink-0">
        {files.map((x, i) => (
          <Button key={x.path} variant="ghost" title={x.path} aria-pressed={i === sel} onClick={() => setSel(i)}
            className={cn('h-auto w-full justify-start gap-2 px-2.5 py-2 text-left font-normal text-fg active:scale-100', i === sel ? 'bg-hover' : 'hover:bg-hover/60')}>
            <span className="min-w-0 flex-1 truncate text-[13px]">{x.path.split('/').pop()}</span>
            <span className="text-[11.5px] tabular-nums text-ok">+{x.add}</span>
            {x.del > 0 && <span className="text-[11.5px] tabular-nums text-err">−{x.del}</span>}
          </Button>
        ))}
        {n > 0 && <Button variant="primary" size="sm" onClick={() => { onAsk(`按我在改动里留的 ${n} 条评论改一下`); setComments({}) }} className="mt-3 w-full tabular-nums">按 {n} 条评论修改</Button>}
      </div>
      <div className="min-w-0 flex-1 overflow-hidden rounded-xl border border-line">
        <div className="truncate border-b border-line bg-hover/50 px-3 py-2 font-mono text-[12px] text-fg-2" title={f.path}>{f.path}</div>
        <div className="font-mono text-[12.5px] leading-[22px]">
          {f.diff.map((l, i) => {
            const key = f.path + ':' + i
            if (l.t === 'hunk') return <div key={i} className="bg-hover/40 px-3 text-fg-3">{l.s}</div>
            return (
              <div key={i}>
                <div className={cn('group/l flex', l.t === 'add' && 'bg-run-soft', l.t === 'del' && 'bg-err-soft')}>
                  <IconButton label="在这一行留评论" tooltip={false} size="icon-xs" icon={<MessageSquarePlus />} onClick={() => { setEditing(key); setDraft(comments[key] ?? '') }}
                    className="h-[22px] w-6 shrink-0 rounded-none text-fg-3 opacity-0 hover:bg-transparent hover:text-fg focus-visible:opacity-100 group-hover/l:opacity-100" />
                  <span className="w-8 shrink-0 select-none pr-2 text-right tabular-nums text-fg-3">{l.n}</span>
                  <span className={cn('w-4 shrink-0 select-none', l.t === 'add' ? 'text-ok' : l.t === 'del' ? 'text-err' : 'text-fg-3')}>{l.t === 'add' ? '+' : l.t === 'del' ? '−' : ''}</span>
                  <span className="whitespace-pre pr-3">{l.s}</span>
                </div>
                {comments[key] && editing !== key && <div className="mx-3 my-1.5 rounded-lg bg-warm-soft px-3 py-1.5 font-sans text-[13px]">你：{comments[key]}</div>}
                {editing === key && (
                  <form className="mx-3 my-1.5 flex gap-2 font-sans" onSubmit={(e) => { e.preventDefault(); if (draft.trim()) setComments((c) => ({ ...c, [key]: draft.trim() })); setEditing(null) }}>
                    <TextInput dense autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="这一行想怎么改？" className="flex-1 bg-elev" />
                    <Button type="submit" variant="primary" size="sm" className="text-[12.5px]">留评论</Button>
                  </form>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
