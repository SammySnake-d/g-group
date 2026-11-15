import { artifacts, dispText, people, type Artifact, type Conversation, type Msg, type PersonId } from '@/data'
import { useAppStore } from '@/store'
import { focusComposer } from '@/store/dom'

type IdMsg = Extract<Msg, { id: string }>
export const sourceLabel = (c: Conversation | undefined) => c ? c.kind === 'group' ? c.title : people[c.members.find((m) => m !== 'me') ?? 'me']?.name ?? c.title : '来源不可用'
/** 文件名、作者、来自哪个对话,任一含搜索词就算命中 */
export const matchFile = (a: Artifact, query: string, convs: Conversation[]) => {
  const q = query.trim().toLocaleLowerCase()
  return !q || `${a.name} ${people[a.by]?.name ?? ''} ${sourceLabel(convs.find((c) => c.id === a.conv))}`.toLocaleLowerCase().includes(q)
}
/** 出现这份文件的那条消息:演示里是文件卡 / 资产卡;连上后端是带附件的消息或交付消息 */
const isSource = (a: Artifact, m: IdMsg) => (m.k === 'file' && m.artifactId === a.id) || (m.k === 'asset' && m.assetId === a.id) || a.live?.src === m.id
export function fileContext(a: Artifact, convs: Conversation[]) {
  const conv = convs.find((c) => c.id === a.conv)
  const messages = (conv?.messages ?? []).filter((m): m is IdMsg => 'id' in m)
  const index = messages.findIndex((m) => isSource(a, m))
  const source = index >= 0 ? messages[index] : undefined
  const near = index >= 0 ? messages.slice(Math.max(0, index - 2), index + 3) : []
  const mentions = messages.filter((m) => m.k === 'text' && m.text.includes(a.name))
  const related = [...new Set([...near, ...mentions])].sort((x, y) => messages.indexOf(x) - messages.indexOf(y))
  return { conv, source, related, messages }
}

/** 来处里的一站:同一个人在对话里紧挨着的几条并成一站;动作只从消息结构里读,读不出就不写 */
export interface Hop { key: string; from: PersonId | null; verb: string | null; msgs: IdMsg[]; target: IdMsg; isSource: boolean }
const from = (m: IdMsg): PersonId | null => ('from' in m ? m.from : null)
export function provenance(a: Artifact, convs: Conversation[]) {
  const ctx = fileContext(a, convs)
  const answeredBy = new Map<string, string>()
  for (const m of ctx.related) if (m.k === 'text' && m.disp?.refKind === 'msg' && m.disp.ref) answeredBy.set(m.disp.ref, dispText[m.disp.kind])
  const verbOf = (m: IdMsg): [string | null, number] => {
    if (isSource(a, m)) return [m.k === 'asset' ? '存下' : '交付', 3]
    if (m.k === 'vote' && m.decided != null) return ['拍板', 2]
    if (answeredBy.has(m.id)) return [answeredBy.get(m.id)!, 2]
    if (m.k === 'text' && m.disp) return ['派活', 2]
    if (m.k === 'file') return ['发文件', 1]
    if (m.k === 'compute') return ['开工', 1]
    if (m.k === 'text' && m.text.includes(a.name)) return ['提到', 1]
    return [null, 0]
  }
  const hops: Hop[] = []
  let prev = -2
  for (const m of ctx.related) {
    const at = ctx.messages.indexOf(m)
    const last = hops.at(-1)
    if (last && at === prev + 1 && from(m) === last.from) last.msgs.push(m)
    else hops.push({ key: m.id, from: from(m) ?? (isSource(a, m) ? a.by : null), verb: null, msgs: [m], target: m, isSource: false })
    prev = at
  }
  for (const h of hops) {
    const ranked = h.msgs.map((m) => ({ m, v: verbOf(m) })).sort((x, y) => y.v[1] - x.v[1])
    h.target = ranked[0].m
    h.verb = ranked[0].v[0]
    h.isSource = h.msgs.some((m) => isSource(a, m))
  }
  return { ...ctx, hops }
}

/** 一站的原话:优先这一站里说的话(交付时的附言常有「重点看第 3 节」这种读法提示),没有话再用消息本身 */
export const hopQuote = (h: Hop) => {
  /* 连上后端时交付那一站本身就是一句话(交付消息):引它,不引同一站里更早的客套 */
  const said = h.isSource && h.target.k === 'text' ? h.target : h.msgs.find((m) => m.k === 'text')
  return (said ? messageText(said) : messageText(h.target)).replace(/\s*\n+\s*/g, ' ')
}
export const hopWho = (h: Hop) => (h.from ? people[h.from].name : '系统')

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
  s.setFileReturn({ file: a.id, conv: conv.id })
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
