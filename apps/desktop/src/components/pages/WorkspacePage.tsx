import { FolderGit2 } from 'lucide-react'
import { people } from '@/data'
import { useApp } from '@/ctx'
import { Avatar } from '@/components/Avatar'
import { EmptyState } from '@/components/ui/section'
import { ListGroup, ListRow } from '@/components/ui/list-row'
import { Hint, PageScroll } from './kit/parts'

/* U27/U28:群工作区与提交归属——对外一个仓库,每条提交记着是哪个助手写的 */
export function WorkspacePage({ id }: { id: string }) {
  const { convs } = useApp()
  const w = convs.find((c) => c.id === id)!.workspace
  if (!w) return <PageScroll className="px-4"><EmptyState icon={<FolderGit2 />} title="这个群还没绑定工作区" /></PageScroll>
  return (
    <PageScroll className="px-1">
      <ListGroup title="工作区">
        <ListRow label="目录" value={<span className="font-code text-[12.5px]" title={w.path}>{w.path}</span>} />
        <ListRow label="分支" value={<span className="font-code text-[12.5px]">{w.branch}</span>} />
      </ListGroup>
      <ListGroup title="最近提交（谁改的都记着）">
        {w.commits.map((c, i) => (
          <div key={i} className="flex items-center gap-2.5 px-4 py-2.5">
            <Avatar id={c.who} size={22} status={false} />
            <div className="min-w-0 flex-1"><div className="truncate text-[13.5px]">{c.msg}</div><div className="truncate text-[11.5px] text-fg-3">{people[c.who].name} · {c.at}</div></div>
            <span className="shrink-0 text-[11.5px] tabular-nums text-ok">+{c.add}</span><span className="shrink-0 text-[11.5px] tabular-nums text-err">−{c.del}</span>
          </div>
        ))}
      </ListGroup>
      <Hint className="mx-4 text-[12px]">对外是一个仓库，内部每条提交都记着是哪个助手写的。回退工作区时，助手的长期记忆不跟着回退。</Hint>
    </PageScroll>
  )
}
