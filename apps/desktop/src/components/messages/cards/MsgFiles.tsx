/* 随消息发出的附件(C-US19):细边卡片,左边类型图标,右边文件名 + 大小 · 谁发的。和交付工件卡同一套外形(Attachments.tsx 的 CARD) */
import { File as FileIcon, FileArchive, FileText, Image as ImageIcon } from 'lucide-react'
import { people } from '@/data'
import { useApp } from '@/store'
import { cn } from '@/lib/utils'
import type { TextMsg } from '../types'

const iconOf = (mime: string) => (mime.startsWith('image/') ? ImageIcon : mime.startsWith('text/') || mime === 'application/pdf' || mime === 'application/json' ? FileText : mime === 'application/zip' ? FileArchive : FileIcon)
/** 字节数 → 人读的大小 */
export function sizeOf(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function MsgFiles({ m }: { m: TextMsg }) {
  const mine = m.from === 'me'
  const { setSection, setFileSel, liveFiles } = useApp((s) => ({ setSection: s.setSection, setFileSel: s.setFileSel, liveFiles: s.liveFiles }))
  return (
    <div className={cn('flex flex-col gap-1.5', mine ? 'items-end' : 'items-start')} data-testid={`files-${m.id}`}>
      {(m.files ?? []).map((f) => {
        const I = iconOf(f.mime)
        const canPreview = liveFiles.some((a) => a.id === f.ref)
        return (
          <button type="button" key={f.ref} data-testid={`attachment-${f.name}`} title={canPreview ? `预览${f.name}` : f.name} onClick={() => { if (canPreview) { setSection('files'); setFileSel(f.ref) } }} disabled={!canPreview} className="flex w-[268px] max-w-full items-center gap-3 rounded-2xl border border-line bg-elev p-2.5 pr-3 text-left text-[13px] disabled:cursor-default disabled:opacity-100 hover:border-fg-3/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
            <div className="grid h-10 w-10 shrink-0 place-items-center rounded-[10px] bg-hover text-fg-2"><I className="h-[18px] w-[18px]" strokeWidth={1.75} /></div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[14px] font-medium">{f.name}</div>
              <div className="truncate text-[12px] tabular-nums text-fg-2">{sizeOf(f.bytes)} · {mine ? '你发的' : `${people[m.from]?.name ?? ''} 发的`}</div>
            </div>
          </button>
        )
      })}
    </div>
  )
}
