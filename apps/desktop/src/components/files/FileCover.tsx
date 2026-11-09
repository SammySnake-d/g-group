import { Check, FileText, Server } from 'lucide-react'
import type { Artifact } from '@/data'
import { useApp } from '@/store'
import { Preview } from '../split/Preview'
import { ARTICLE_SEC4, PLAYBOOK_SECTIONS, ASSET_ROWS, articleSections } from '../split/constants'

// 缩略页只展示当前内容的节选，不生成虚构完成状态、指标或图形占位。
export function FileCover({ artifact: a }: { artifact: Artifact }) {
  const tasks = useApp((s) => s.checklist.filter((t) => t.conv === a.conv))
  if (a.kind === 'page') return <div className="file-cover file-cover-web" aria-hidden><Preview kind="login" small /></div>
  if (a.kind === 'asset') return <div className="file-cover flex flex-col justify-between p-6"><Server className="h-8 w-8 text-fg-2" /><div className="font-code text-[17px]">{ASSET_ROWS[0][1]}</div><div className="flex justify-between text-[13px] text-fg-2"><span>{ASSET_ROWS[1][1]}</span><span>{ASSET_ROWS[3][1]}</span></div></div>
  if (a.kind === 'sheet') return <div className="file-cover space-y-3 px-6 py-5">{tasks.slice(0, 4).map((t) => <div key={t.id} className="flex items-center gap-3 text-[13px]"><span className="grid h-4 w-4 shrink-0 place-items-center rounded border border-line">{t.status === '已完成' && <Check className="h-3 w-3" />}</span><span className="truncate">{t.text}</span></div>)}</div>
  const sections = a.id === 'a1' ? articleSections(ARTICLE_SEC4) : PLAYBOOK_SECTIONS
  return <div className="file-cover overflow-hidden px-6 py-5"><FileText className="mb-4 h-5 w-5 text-fg-2" />{sections.slice(0, 2).map(([title, body]) => <section key={title} className="mb-4"><h3 className="mb-1 text-[14px] font-semibold">{title}</h3><p className="line-clamp-2 text-[13px] leading-relaxed text-fg-2">{body}</p></section>)}</div>
}
