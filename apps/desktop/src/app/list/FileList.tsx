import { ArtifactIcon } from '@/components/Messages'
import { people } from '@/data'
import { useApp } from '@/store'
import { fileList } from '@/store/slices/files'
import { ListRow } from '../ListRow'
import { FILE_KINDS } from './labels'
import { matchFile } from '@/components/files/context'

/** 文件区:按类别分组(网页 / 文档 / 清单 / 资产),写明谁在哪个会话里做的 */
export function FileList({ query }: { query: string }) {
  const { convs, fileSel, setFileSel } = useApp((s) => ({ convs: s.convs, fileSel: s.fileSel, setFileSel: s.setFileSel }))
  /* 连上后端列 files.list 读到的,没连上列演示文件 */
  const files = useApp(fileList)
  const hit = files.filter((a) => matchFile(a, query, convs))
  return (
    <>
      {!hit.length && <div className="px-2 py-6 text-center text-[13px] text-fg-3">没有找到文件</div>}
      {FILE_KINDS.map(({ kind, label }) => {
        const list = hit.filter((a) => a.kind === kind)
        if (!list.length) return null
        return (
          <div key={kind}>
            <div className="px-2 pb-1 pt-2 text-[12px] font-medium text-fg-3">{label}</div>
            {list.map((a) => (
              <ListRow key={a.id} data-testid={`file-${a.id}`} onClick={() => setFileSel(a.id)} selected={fileSel === a.id} className="gap-2.5 rounded-xl px-2 py-1.5">
                <ArtifactIcon kind={a.kind} className="h-9 w-9" />
                <div className="min-w-0 flex-1"><div className="truncate text-[14px] font-medium">{a.name}</div><div className="truncate text-[12px] text-fg-2">{[...new Set([people[a.by]?.name, convs.find((c) => c.id === a.conv)?.title])].filter(Boolean).join(' · ')} · {a.when}</div></div>
              </ListRow>
            ))}
          </div>
        )
      })}
    </>
  )
}
