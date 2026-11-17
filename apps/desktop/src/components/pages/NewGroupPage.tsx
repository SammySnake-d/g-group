import { cn } from '@/lib/utils'
import { useState } from 'react'
import { people } from '@/data'
import { useApp } from '@/ctx'
import { Avatar } from '@/components/Avatar'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Segmented } from '@/components/ui/segmented'
import { PageFooter, PageScroll, TextInput, ctaDisabled } from './kit/parts'
import { NEW_GROUP_POOL } from './constants'

/* ---------- 发起群聊:群名可不填;勾人;底部选临时算力格数,主按钮写明还差什么 / 建好有几人 ---------- */
export function NewGroupPage() {
  const { createGroup, closeAll } = useApp()
  const [title, setTitle] = useState('')
  const [pick, setPick] = useState<Record<string, boolean>>({})
  const [pool, setPoolN] = useState(0)
  const list = Object.values(people).filter((p) => p.id !== 'me' && p.id !== 'helper')
  const ids = Object.keys(pick).filter((k) => pick[k])
  return (
    <>
      <div className="px-4 pb-2"><TextInput aria-label="群名" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="群名（可以不填）" /></div>
      <PageScroll className="px-2">
        {list.map((p) => (
          <label key={p.id} className="flex cursor-pointer items-center gap-3 rounded-xl px-2.5 py-2 transition-colors duration-fast ease-out hover:bg-hover has-[:focus-visible]:bg-hover">
            <Checkbox checked={!!pick[p.id]} onCheckedChange={(v) => setPick((x) => ({ ...x, [p.id]: !!v }))} className="rounded-full border-fg-3 data-[state=checked]:border-me data-[state=checked]:bg-me data-[state=checked]:text-me-fg" />
            <Avatar id={p.id} size={34} status={false} />
            <div className="min-w-0 flex-1"><div className="truncate text-[14px] font-medium">{p.name}</div><div className="truncate text-[12px] text-fg-2">{p.role}</div></div>
          </label>
        ))}
      </PageScroll>
      <PageFooter>
        <div className="mb-2.5 flex items-center gap-2 text-[13px]" data-testid="newgroup-pool">
          <span className="shrink-0 text-fg-2">临时算力</span>
          <Segmented ariaLabel="临时算力" size="xs" value={String(pool)} onChange={(v) => setPoolN(Number(v))}
            options={NEW_GROUP_POOL.map((n) => ({ value: String(n), label: n === 0 ? '不给' : `${n} 格`, testid: `newgroup-pool-${n}` }))} />
          <span className="ml-auto min-w-0 truncate text-[12px] text-fg-3">人少时补算力，做完就还</span>
        </div>
        <Button variant="primary" size="md" className={cn('w-full tabular-nums', ctaDisabled)} disabled={ids.length < 2} onClick={() => { createGroup(title.trim() || ids.map((i) => people[i].name).slice(0, 3).join('、'), ids, undefined, pool); closeAll() }}>
          {ids.length < 2 ? '至少选 2 人' : `创建群聊（${ids.length + 1} 人）`}
        </Button>
      </PageFooter>
    </>
  )
}
