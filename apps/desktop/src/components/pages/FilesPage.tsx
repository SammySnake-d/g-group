import { FileStack } from 'lucide-react'
import { artifacts, people } from '@/data'
import { useApp } from '@/ctx'
import { ArtifactIcon } from '@/components/Messages'
import { EmptyState } from '@/components/ui/section'
import { ListItem } from '@/components/ui/list-row'
import { Hint, PageScroll } from './kit/parts'

/* ---------- 群文件:助手交付的文档、页面、任务板、服务器账号;点一个在分屏里打开 ---------- */
export function FilesPage({ id }: { id: string }) {
  const { openSplit, closeAll } = useApp()
  const list = artifacts.filter((a) => a.conv === id)
  return (
    <PageScroll className="px-2">
      {list.map((a) => (
        <ListItem key={a.id} onClick={() => { openSplit({ t: 'artifact', id: a.id }); closeAll() }}
          media={<ArtifactIcon kind={a.kind} className="h-9 w-9" />}
          title={a.name} subtitle={`${a.meta} · ${people[a.by].name} · ${a.when}`} />
      ))}
      {!list.length && <EmptyState icon={<FileStack />} title="还没有文件" />}
      <Hint className="mx-2 mt-2 text-[12px]">群文件是群里共享的资产：助手交付的文档、页面、任务板、服务器账号都在这。删聊天记录不会删文件。</Hint>
    </PageScroll>
  )
}
