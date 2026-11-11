import type { Artifact, Conversation, Msg } from '@/data'

// 只由开发/设计导出模式启用的同形数据边界，不改 DOM 或 CSS 来伪造极端状态。
const cases = new Map<string, Artifact[]>()
export function fileDataset(mode: string | null, original: Artifact[]): Artifact[] {
  if (!mode) return original
  const cached = cases.get(mode)
  if (cached) return cached
  let result = original
  if (mode === 'empty') result = []
  if (mode === 'one') result = original.slice(0, 1)
  if (mode === 'worst') result = original.map((a, i) => ({ ...a, name: [
    'Q3 Board Deck — FINAL (revised) v12 [approved by legal].pdf',
    'IMG_20250914_183022_HDR_portrait_edited_edited.HEIC',
    '多模型协作产品跨端交互与信息架构调整清单（十一月审阅版）',
    '香港服务器生产环境部署与灾难恢复记录',
    '群协作手册',
  ][i] ?? a.name }))
  if (mode === 'many') result = Array.from({ length: 1200 }, (_, i) => ({ ...original[i % original.length], id: `volume-${i}`, name: `交互对照-${i + 1}.md` }))
  cases.set(mode, result)
  return result
}

/* 来处的极端数据:同一份文件在对话里被反复提到、派活、承接,原话很长。只由开发/设计导出模式启用。 */
const busy: Msg[] = [
  { k: 'text', id: 'pv1', from: 'codex', text: '看了《IM 竞品交互对照》第 2 节。连发合并我们现在按 3 分钟一个窗口，Telegram 是 1 分钟，QQ 不按时间按“有没有人插话”，要不要对齐其中一家？我倾向 QQ 的做法，插话就断开。' },
  { k: 'text', id: 'pv2', from: 'me', disp: { by: 'claude', kind: 'doing', ref: 'pv3', refKind: 'msg' }, text: '@Claude Code 按 IM 竞品交互对照第 4 节，把需要我决定的卡片挪到输入框正上方，选完在聊天里留一条记录' },
  { k: 'text', id: 'pv3', from: 'claude', text: '收到，在改。IM 竞品交互对照里 Telegram 机器人按钮贴着输入框那种，我先做一版给你看，大概二十分钟。' },
  { k: 'text', id: 'pv4', from: 'astra', text: '补充：IM 竞品交互对照新增了第 6 节「多人同时在做时怎么显示」。iMessage 和 QQ 差别很大，这节比较长，建议先看结论那一段再看细节，结论是只显示一行“3 位助手在做”，点开再看各自在做什么。' },
  { k: 'text', id: 'pv5', from: 'argon', text: '我把第 6 节的结论也记进群协作手册了，和 IM 竞品交互对照对得上。' },
]
export function provFixture(mode: string | null, convs: Conversation[]): Conversation[] {
  if (!mode?.includes('busy')) return convs
  return convs.map((c) => (c.id === 'g' ? { ...c, messages: [...c.messages, ...busy] } : c))
}
