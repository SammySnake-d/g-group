import { ArtifactIcon } from '@/components/Messages'
import { artifacts, people } from '@/data'
import { useApp } from '@/store'
import { ListRow } from '../ListRow'
import { FILE_KINDS } from './labels'

/** 文件区:按类别分组(网页 / 文档 / 清单 / 资产),写明谁在哪个会话里做的 */
export function FileList() {
  const { convs, fileSel, setFileSel } = useApp((s) => ({ convs: s.convs, fileSel: s.fileSel, setFileSel: s.setFileSel }))
  return (
    <>
      {FILE_KINDS.map(({ kind, label }) => {
        const list = artifacts.filter((a) => a.kind === kind)
        if (!list.length) return null
        return (
          <div key={kind}>
            <div className="px-2 pb-1 pt-2 text-[12px] font-medium text-fg-3">{label}</div>
            {list.map((a) => (
              <ListRow key={a.id} data-testid={`file-${a.id}`} onClick={() => setFileSel(a.id)} selected={fileSel === a.id} className="gap-2.5 rounded-xl px-2 py-1.5">
                <ArtifactIcon kind={a.kind} className="h-9 w-9" />
                <div className="min-w-0 flex-1"><div className="truncate text-[14px] font-medium">{a.name}</div><div className="truncate text-[12px] text-fg-2">{people[a.by].name} · {convs.find((c) => c.id === a.conv)?.title} · {a.when}</div></div>
              </ListRow>
            ))}
          </div>
        )
      })}
    </>
  )
}
