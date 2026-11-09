import { artifacts, people, type Artifact, type Conversation, type Msg } from '@/data'
import { useAppStore } from '@/store'
import { focusComposer } from '@/store/dom'

type IdMsg = Extract<Msg, { id: string }>
export const sourceLabel = (c: Conversation | undefined) => c ? c.kind === 'group' ? c.title : people[c.members.find((m) => m !== 'me') ?? 'me'].name : '来源不可用'
export function fileContext(a: Artifact, convs: Conversation[]) {
  const conv = convs.find((c) => c.id === a.conv)
  const messages = (conv?.messages ?? []).filter((m): m is IdMsg => 'id' in m)
  const index = messages.findIndex((m) => m.k === 'file' && m.artifactId === a.id)
  const source = index >= 0 ? messages[index] : undefined
  const near = index >= 0 ? messages.slice(Math.max(0, index - 2), index + 3) : []
  const mentions = messages.filter((m) => m.k === 'text' && m.text.includes(a.name))
  return { conv, source, related: [...near, ...mentions.filter((m) => !near.includes(m))] }
}
export function messageText(m: IdMsg): string {
  if ('text' in m) return m.text
  if ('title' in m) return m.title
  if (m.k === 'file') return artifacts.find((a) => a.id === m.artifactId)?.name ?? '文件'
  if (m.k === 'compute') return '开了一个 Compute'
  if (m.k === 'forward') return m.srcTitle
  return '消息'
}
// 文件不是对话之外的孤岛。只预填草稿、不发送；有原消息才挂真正的回复引用。
export function discussFile(a: Artifact) {
  const s = useAppStore.getState()
  const { conv, source } = fileContext(a, s.convs)
  if (!conv) return
  s.openConv(conv.id)
  if (source && 'from' in source) s.addQuote({ msgId: source.id, from: source.from, text: a.name, reply: true })
  else {
    s.setDraft((draft) => {
      if (draft.includes(a.name)) return draft
      const at = `@${people[a.by].name}`
      return `${draft.includes(at) ? '' : at + ' '}${draft}${draft && !draft.endsWith(' ') ? ' ' : ''}关于「${a.name}」：`
    })
    focusComposer()
  }
}
