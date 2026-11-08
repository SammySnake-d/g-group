import { CornerUpLeft, FileSearch, MessageSquare } from 'lucide-react'
import { cn } from '@/lib/utils'
import { artifacts, people, type Conversation, type Msg } from '@/data'
import { useApp } from '@/ctx'
import { Button } from '@/components/ui/button'
import { ListItem } from '@/components/ui/list-row'
import { EmptyState } from '@/components/ui/section'
import { Hint } from '@/components/pages/kit/parts'
import { ARTICLE_INTRO, ARTICLE_SEC4, ASSET_NOTE_FILES, PLAYBOOK_INTRO, PLAYBOOK_SECTIONS, articleSections } from './split/constants'
import { AssetTable } from './split/ArtifactView'
import { Avatar, GroupAvatar } from './Avatar'
import { ArtifactIcon } from './Messages'
import { Preview } from './Split'

/* 「文件」主面板:左边预览,右边「和这个文件有关的消息」。每个文件都写明来自哪个聊天、谁交付的,一键跳回原消息。 */

const convLabel = (c: Conversation) => {
  if (c.kind === 'group') return c.title
  const peer = c.members.find((m) => m !== 'me')
  return `与 ${peer ? people[peer].name : c.title} 私聊`
}

type IdMsg = Extract<Msg, { id: string }>
const msgText = (m: IdMsg): string => {
  if (m.k === 'text') return m.text
  if (m.k === 'sys') return m.text
  if (m.k === 'file') return `发了文件「${artifacts.find((a) => a.id === m.artifactId)?.name ?? ''}」`
  if (m.k === 'compute') return '分了一个 Compute'
  if (m.k === 'asset') return m.text
  if (m.k === 'summary' || m.k === 'vote') return m.title
  if (m.k === 'huddle') return '几个助手讨论了一下'
  if (m.k === 'forward') return `转发了「${m.srcTitle}」`
  return '一条消息'
}
const msgFrom = (m: IdMsg) => ('from' in m ? m.from : null)

/** 文档正文:标题 + 段落 */
function Doc({ intro, sections }: { intro: string; sections: [string, string][] }) {
  return (
    <article className="space-y-3 text-[14.5px] leading-[1.8]">
      <p className="text-fg-2">{intro}</p>
      {sections.map(([h, b]) => <section key={h}><h3 className="text-[15.5px] font-semibold">{h}</h3><p>{b}</p></section>)}
    </article>
  )
}

export function FilesMain({ id }: { id: string | null }) {
  const { convs, checklist, jump, openConv } = useApp()
  const a = id ? artifacts.find((x) => x.id === id) : undefined

  if (!a) return (
    <main data-testid="files-main" data-file={id ?? ''} className="grid min-w-0 flex-1 place-items-center px-8">
      <EmptyState icon={<FileSearch strokeWidth={1.5} />} title="选一个文件，在这里预览。" hint="每个文件都会告诉你它来自哪个聊天。" />
    </main>
  )

  const conv = convs.find((c) => c.id === a.conv)
  const msgs = (conv?.messages ?? []).filter((m): m is IdMsg => 'id' in m)
  const fileIdx = msgs.findIndex((m) => m.k === 'file' && m.artifactId === a.id)
  const fileMsg = fileIdx >= 0 ? msgs[fileIdx] : undefined
  const near = fileIdx >= 0 ? msgs.slice(Math.max(0, fileIdx - 2), fileIdx + 3) : []
  const mention = msgs.filter((m) => m.k === 'text' && m.text.includes(a.name))
  const related = [...near, ...mention.filter((m) => !near.includes(m))]
  const label = conv ? convLabel(conv) : '未知聊天'
  const goSource = () => (fileMsg ? jump(fileMsg.id) : conv && openConv(conv.id))
  const tasks = checklist.filter((t) => t.conv === a.conv)

  return (
    <div data-testid="files-main" data-file={a.id} className="flex min-w-0 flex-1">
      <main className="scroll-thin min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[720px] px-8 pb-12 pt-6">
          <div className="flex items-center gap-3">
            <ArtifactIcon kind={a.kind} />
            <div className="min-w-0">
              <h1 className="truncate text-[18px] font-semibold tracking-tight">{a.name}</h1>
              <div className="text-[12.5px] text-fg-2">{a.meta}</div>
            </div>
          </div>
          <div data-testid="file-source" className="mt-4 flex flex-wrap items-center gap-2 rounded-xl border border-line bg-side px-3 py-2.5 text-[13px]">
            {conv && (conv.kind === 'group' ? <GroupAvatar ids={conv.members} size={20} /> : <Avatar id={conv.members.find((m) => m !== 'me') ?? 'me'} size={20} status={false} mood="idle" />)}
            <span className="min-w-0 flex-1">来自「{label}」· 由 <Avatar id={a.by} size={16} status={false} mood="idle" className="inline-block align-[-3px]" /> {people[a.by].name} 交付 · {a.when}</span>
            <Button data-testid="file-jump" variant="primary" size="xs" onClick={goSource}><CornerUpLeft />跳到原消息</Button>
            {conv && <Button data-testid="file-open-conv" variant="outline" size="xs" onClick={() => openConv(conv.id)} className="max-w-[16rem] font-normal"><span className="truncate">打开「{label}」</span></Button>}
          </div>

          <div className="mt-6" data-testid="file-preview">
            {a.kind === 'page' ? <Preview kind="login" />
              : a.kind === 'sheet' ? (
                <>
                  <Hint className="mb-2">这是群清单，属于「{label}」，不属于哪个助手。</Hint>
                  <div className="overflow-hidden rounded-xl border border-line">
                    {tasks.map((t) => (
                      <div key={t.id} className="flex items-center gap-3 border-b border-line px-4 py-2.5 text-[13.5px] last:border-0">
                        <span className={cn('min-w-0 flex-1 truncate', t.status === '已完成' && 'text-fg-3')}>{t.text}</span>
                        {t.who ? <span className="inline-flex items-center gap-1.5 text-[12.5px] text-fg-2"><Avatar id={t.who} size={16} status={false} mood="idle" />{people[t.who].name}</span> : <span className="text-[12.5px] text-fg-3">没人领</span>}
                        <span className={cn('w-14 shrink-0 text-right text-[12.5px]', t.status === '待验收' ? 'font-semibold text-warm' : t.status === '已完成' ? 'text-fg-3' : 'text-fg-2')}>{t.status}</span>
                      </div>
                    ))}
                    {tasks.length === 0 && <div className="px-4 py-6 text-center text-[13px] text-fg-3">这个聊天的清单是空的</div>}
                  </div>
                </>
              ) : a.kind === 'asset' ? (
                <div className="space-y-3">
                  <AssetTable />
                  <div className="text-[12.5px] text-fg-3">{ASSET_NOTE_FILES}</div>
                </div>
              ) : a.id === 'a1' ? <Doc intro={ARTICLE_INTRO} sections={articleSections(ARTICLE_SEC4)} />
              : <Doc intro={PLAYBOOK_INTRO} sections={PLAYBOOK_SECTIONS} />}
          </div>
        </div>
      </main>
      <aside data-testid="file-related" className="scroll-thin w-[260px] shrink-0 overflow-y-auto border-l border-line bg-side px-3 py-5">
        <div className="px-1 text-[13px] font-semibold">和这个文件有关的消息</div>
        <div className="mt-0.5 truncate px-1 text-[12px] text-fg-3">在「{label}」里，点一条跳过去</div>
        <div className="mt-3 space-y-1">
          {related.length === 0 && <div className="px-1 py-4 text-[12.5px] text-fg-3"><MessageSquare className="mb-1 h-4 w-4" />聊天里没找到相关的消息</div>}
          {related.map((m) => {
            const from = msgFrom(m)
            return (
              <ListItem
                key={m.id}
                data-testid={`file-related-${m.id}`}
                onClick={() => jump(m.id)}
                selected={m === fileMsg}
                subtitleFirst
                className="rounded-lg px-2 py-2"
                subtitle={<span className="inline-flex max-w-full items-center gap-1.5">{from && <Avatar id={from} size={14} status={false} mood="idle" />}<span className="truncate">{from ? people[from].name : '系统'}</span>{m === fileMsg && <span className="shrink-0 text-fg-3">· 原消息</span>}</span>}
                title={<span className="text-[12.5px]">{msgText(m)}</span>}
              />
            )
          })}
        </div>
      </aside>
    </div>
  )
}
