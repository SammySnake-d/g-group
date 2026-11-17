import { ArrowUpRight, NotebookPen } from 'lucide-react'
import { people } from '@/data'
import { useApp } from '@/ctx'
import { Avatar } from '@/components/Avatar'
import { Button } from '@/components/ui/button'
import { Chip } from '@/components/ui/chip'
import { EmptyState } from '@/components/ui/section'
import { Surface } from '@/components/ui/surface'
import { Hint, PageScroll } from './kit/parts'

/* ---------- US11 / US6 承诺:每个助手从你的话里记下的事;每条能跳回那句话 ---------- */
export function CommitsPage({ id }: { id: string }) {
  const { commits, jump, convs } = useApp()
  const list = commits.filter((c) => c.conv === id)
  return (
    <PageScroll className="px-1">
      <Hint className="mx-4 mb-3">你在群里说的话，每个助手会自己判断和自己有没有关系，有关就记成自己要做的事。绑定的任务都做完后自动失效。</Hint>
      <div className="mx-3 space-y-2">
        {list.map((c) => (
          <Surface key={c.id} elevation="sunken" className="p-3">
            <div className="flex min-w-0 items-center gap-2">
              <Avatar id={c.owner} size={22} status={false} />
              <span className="min-w-0 truncate text-[13.5px] font-medium">{people[c.owner].name}</span>
              <Chip size="sm" className="bg-elev">{c.trigger}</Chip>
              {c.next && <span className="shrink-0 text-[11.5px] tabular-nums text-fg-3">下次 {c.next}</span>}
            </div>
            <div className="mt-1.5 text-[13.5px] leading-relaxed">{c.text}</div>
            <Button variant="link" size="xs" onClick={() => jump(c.srcMsg)} className="mt-0.5 gap-0.5 text-[12px] text-fg-3 hover:text-fg">来自你的这句话<ArrowUpRight /></Button>
          </Surface>
        ))}
      </div>
      {!list.length && <EmptyState icon={<NotebookPen />} title="这个群里还没有人记下什么" />}
      <Hint className="mx-4 mt-2 text-[12px]">在{convs.find((c) => c.id === id)?.title}里说“别汇报了”或“取消每天的总结”，对应的助手会撤掉。</Hint>
    </PageScroll>
  )
}
