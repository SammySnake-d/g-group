import { cn } from '@/lib/utils'
import type { Artifact } from '@/data'
import { useApp } from '@/store'
import { boot } from '@/store/boot'
import { Avatar } from '../Avatar'
import { Preview } from '../split/Preview'
import { AssetTable } from '../split/ArtifactView'
import { ARTICLE_INTRO, ARTICLE_SEC4, PLAYBOOK_INTRO, PLAYBOOK_SECTIONS, articleSections } from '../split/constants'

// 正文仍来自原来的内容源；目录缩略图和阅读页不另造一套文件内容。
export function FileBody({ artifact: a }: { artifact: Artifact }) {
  const tasks = useApp((s) => s.checklist.filter((t) => t.conv === a.conv))
  if (a.kind === 'page') return <Preview kind="login" />
  if (a.kind === 'asset') return <AssetTable />
  if (a.kind === 'sheet') return <div className="divide-y divide-line">{tasks.map((t) => <div key={t.id} className="flex items-center gap-4 py-4 text-[14px]">
    <span className={cn('min-w-0 flex-1', t.status === '已完成' && 'text-fg-2')}>{t.text}</span>
    {t.who && <Avatar id={t.who} size={24} status={false} mood="idle" />}
    <span className={cn('shrink-0', t.status === '待验收' ? 'text-warm' : 'text-fg-2')}>{t.status}</span>
  </div>)}{!tasks.length && <p className="py-8 text-fg-2">清单为空</p>}</div>
  const base = a.id === 'a1' ? articleSections(ARTICLE_SEC4) : PLAYBOOK_SECTIONS
  // 走查用长文档:同样的小节接几遍,验证往下翻时右侧来处还在
  const sections = boot.provFixture?.includes('long') ? Array.from({ length: 6 }, (_, i) => base.map(([h, b]) => [`${h}${i ? `（${i + 1}）` : ''}`, b] as const)).flat() : base
  return <article className="space-y-7 text-[15px] leading-[1.9]">
    <p className="text-fg-2">{a.id === 'a1' ? ARTICLE_INTRO : PLAYBOOK_INTRO}</p>
    {sections.map(([h, b]) => <section key={h}><h2 className="mb-2 text-[17px] font-semibold">{h}</h2><p>{b}</p></section>)}
  </article>
}
