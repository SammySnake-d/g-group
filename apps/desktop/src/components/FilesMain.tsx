import { CornerUpLeft, FileSearch, MessageSquare } from 'lucide-react'
import { cn } from '@/lib/utils'
import { artifacts, people, type Conversation, type Msg } from '@/data'
import { useApp } from '@/ctx'
import { Avatar, GroupAvatar } from './Avatar'
import { ArtifactIcon } from './Messages'
import { Preview } from './Split'

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

export function FilesMain({ id }: { id: string | null }) {
  const { convs, checklist, jump, openConv } = useApp()
  const a = id ? artifacts.find((x) => x.id === id) : undefined

  if (!a) return (
    <main data-testid="files-main" data-file={id ?? ''} className="grid min-w-0 flex-1 place-items-center px-8 text-center">
      <div className="text-[13.5px] text-fg-3"><FileSearch className="mx-auto mb-3 h-7 w-7" strokeWidth={1.5} />选一个文件，在这里预览。<br />每个文件都会告诉你它来自哪个聊天。</div>
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
            <button data-testid="file-jump" onClick={goSource} className="inline-flex h-7 items-center gap-1 rounded-md bg-btn px-2.5 text-[12.5px] font-medium text-btn-fg"><CornerUpLeft className="h-3.5 w-3.5" />跳到原消息</button>
            {conv && <button data-testid="file-open-conv" onClick={() => openConv(conv.id)} className="h-7 rounded-md border border-line px-2.5 text-[12.5px] hover:bg-hover">打开「{label}」</button>}
          </div>

          <div className="mt-6" data-testid="file-preview">
            {a.kind === 'page' ? <Preview kind="login" />
              : a.kind === 'sheet' ? (
                <>
                  <p className="mb-2 text-[12.5px] text-fg-3">这是群清单，属于「{label}」，不属于哪个助手。</p>
                  <div className="overflow-hidden rounded-xl border border-line">
                    {checklist.filter((t) => t.conv === a.conv).map((t) => (
                      <div key={t.id} className="flex items-center gap-3 border-b border-line px-4 py-2.5 text-[13.5px] last:border-0">
                        <span className={cn('min-w-0 flex-1 truncate', t.status === '已完成' && 'text-fg-3')}>{t.text}</span>
                        {t.who ? <span className="inline-flex items-center gap-1.5 text-[12.5px] text-fg-2"><Avatar id={t.who} size={16} status={false} mood="idle" />{people[t.who].name}</span> : <span className="text-[12.5px] text-fg-3">没人领</span>}
                        <span className={cn('w-14 shrink-0 text-right text-[12.5px]', t.status === '待验收' ? 'font-semibold text-warm' : t.status === '已完成' ? 'text-fg-3' : 'text-fg-2')}>{t.status}</span>
                      </div>
                    ))}
                    {checklist.filter((t) => t.conv === a.conv).length === 0 && <div className="px-4 py-6 text-center text-[13px] text-fg-3">这个聊天的清单是空的</div>}
                  </div>
                </>
              ) : a.kind === 'asset' ? (
                <div className="space-y-3">
                  <div className="overflow-hidden rounded-xl border border-line">
                    {[['地址', '43.•••.•••.12'], ['用户', 'root'], ['密码', '已加密保存，助手只拿到引用，看不到明文'], ['部署目录', '/srv/app']].map(([k, v]) => (
                      <div key={k} className="flex border-b border-line px-4 py-2.5 text-[13.5px] last:border-0"><span className="w-24 shrink-0 text-fg-2">{k}</span><span>{v}</span></div>
                    ))}
                  </div>
                  <div className="text-[12.5px] text-fg-3">删掉原消息不会删掉这条资产</div>
                </div>
              ) : a.id === 'a1' ? (
                <article className="space-y-3 text-[14.5px] leading-[1.8]">
                  <p className="text-fg-2">对照了 QQ、Telegram、GrokBot、iMessage 四款产品，看它们怎么处理“谁在做事”和“要你处理什么”。</p>
                  {[
                    ['1. 列表', '四家都只给一行预览。需要你处理时只改这一行的颜色，不加徽章。'],
                    ['2. 消息', '气泡不描边，连发合并。系统事件只占一行居中灰字。'],
                    ['3. 进度在聊天里', '大家都把“谁在干活”放在聊天里，而不是另开页面。'],
                    ['4. 决定不混在消息里', 'Telegram 的机器人按钮贴在输入框上方；iMessage 的快捷回复也在输入区。'],
                  ].map(([h, b]) => <section key={h}><h3 className="text-[15.5px] font-semibold">{h}</h3><p>{b}</p></section>)}
                </article>
              ) : (
                <article className="space-y-3 text-[14.5px] leading-[1.8]">
                  <p className="text-fg-2">群里约定的做事方式，助手每轮都会读。</p>
                  {[
                    ['分工', '派活请 @ 对应的助手；前端找 Claude Code，性能找 Codex。'],
                    ['交接', '做完先换模型复核，再请你验收。'],
                    ['要你拍板的事', '助手发一条消息 @你，选项挂在消息下面。'],
                  ].map(([h, b]) => <section key={h}><h3 className="text-[15.5px] font-semibold">{h}</h3><p>{b}</p></section>)}
                </article>
              )}
          </div>
        </div>
      </main>
      <aside data-testid="file-related" className="scroll-thin w-[260px] shrink-0 overflow-y-auto border-l border-line bg-side px-3 py-5">
        <div className="px-1 text-[13px] font-semibold">和这个文件有关的消息</div>
        <div className="mt-0.5 px-1 text-[12px] text-fg-3">在「{label}」里，点一条跳过去</div>
        <div className="mt-3 space-y-1">
          {related.length === 0 && <div className="px-1 py-4 text-[12.5px] text-fg-3"><MessageSquare className="mb-1 h-4 w-4" />聊天里没找到相关的消息</div>}
          {related.map((m) => {
            const from = msgFrom(m)
            return (
              <button key={m.id} data-testid={`file-related-${m.id}`} onClick={() => jump(m.id)} className={cn('w-full rounded-lg px-2 py-2 text-left hover:bg-hover', m === fileMsg && 'bg-sel')}>
                <div className="flex items-center gap-1.5 text-[12px] text-fg-2">{from && <Avatar id={from} size={14} status={false} mood="idle" />}{from ? people[from].name : '系统'}{m === fileMsg && <span className="text-fg-3">· 原消息</span>}</div>
                <div className="mt-0.5 line-clamp-2 text-[12.5px]">{msgText(m)}</div>
              </button>
            )
          })}
        </div>
      </aside>
    </div>
  )
}
