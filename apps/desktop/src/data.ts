/* ============ 原型数据：联系人、Compute、会话、待你处理 ============
   每段数据旁边标了它服务的用户故事（US）与验收条目（AC），走查脚本按这些编号核对。 */
import type { ModelSlot, StallOverride } from '@g-group/ui-core'

import { seedInstalled, type CronTrigger, type OutboundGrant, type PluginInstall, type PluginManifest, type RiskLevel } from '@g-group/ui-core'

export type PersonId = string

export interface Person {
  id: PersonId
  name: string
  shape?: string
  color?: string
  initials?: string
  role: string
  /** 说话模型（模型目录里的 id，见 modelConfig.ts）。联系人说话不选 Harness */
  model?: string
  /** Compute 用哪个 Harness（合同 HARNESSES） */
  harness?: string
  /** AC-32 Compute 模型三态：继承全局 / 跟随说话模型 / 单独指定；effort 跟着槽位走 */
  computeModel?: ModelSlot
  /** U92：按联系人单独设的卡死判定阈值；没设的项用默认 15 分钟 / 120 秒 */
  stall?: StallOverride
  computeQuota?: number
  today?: string
  month?: string
  human?: boolean
  focus?: string // US12 专职专注
  tools?: { name: string; on: boolean; kind: 'skill' | 'mcp' }[]
  soul?: string
  memory?: { text: string; src: string }[]
  versions?: { v: number; at: string; note: string }[]
}

const defaultTools = (): Person['tools'] => [
  { name: '读写代码仓库', on: true, kind: 'skill' },
  { name: '跑测试', on: true, kind: 'skill' },
  { name: '浏览器（看页面、截图）', on: true, kind: 'mcp' },
  { name: '网页搜索', on: true, kind: 'mcp' },
  { name: '飞书消息（只读）', on: false, kind: 'mcp' },
  { name: '发邮件', on: false, kind: 'mcp' },
]

export const people: Record<PersonId, Person> = {
  me: { id: 'me', name: '39impacts', initials: '39', role: '你', human: true, color: '#52525b' },
  helper: { id: 'helper', name: 'Helper', shape: 'lightbulb', color: '#f8a01c', role: '帮你操作这个软件', model: 'claude-haiku-5-5' },
  claude: { id: 'claude', name: 'Claude Code', shape: 'chat', color: '#ff6a1a', role: '写代码、做审查', model: 'claude-opus-5-5', harness: 'claude-code', computeModel: { mode: 'follow-speaking', effort: 'xhigh' }, computeQuota: 3, today: '¥3.20', month: '¥41.60', tools: defaultTools() },
  argon: { id: 'argon', name: 'Argon', shape: 'book', color: '#a8693f', role: '整理文档、梳理需求', model: 'gemini-4', harness: 'claude-code', computeModel: { mode: 'explicit', model: 'claude-opus-5-5' }, computeQuota: 2, today: '¥1.10', month: '¥18.40', tools: defaultTools() },
  astra: { id: 'astra', name: 'Astra', shape: 'shield', color: '#1f7cf2', role: '独立复核', model: 'gpt-6', harness: 'codex', computeModel: { mode: 'inherit' }, computeQuota: 2, today: '¥0.80', month: '¥12.90', tools: defaultTools() },
  codex: { id: 'codex', name: 'Codex', shape: 'controller', color: '#8b5cf6', role: '修 bug、性能优化', model: 'gpt-6.1', harness: 'codex', computeModel: { mode: 'follow-speaking' }, computeQuota: 2, today: '¥0.40', month: '¥9.70', tools: defaultTools() },
  grok: { id: 'grok', name: 'Grok', shape: 'magnifier', color: '#14b3a5', role: '资料调研', model: 'grok-5', harness: 'claude-code', computeModel: { mode: 'inherit' }, computeQuota: 1, today: '¥0.20', month: '¥2.10', tools: defaultTools() },
  gemini: { id: 'gemini', name: 'Gemini Flash', shape: 'sprout', color: '#1fbf68', role: '轻量问答', model: 'gemini-flash', harness: 'claude-code', computeModel: { mode: 'inherit' }, computeQuota: 1, today: '¥0', month: '¥0.60', tools: defaultTools() },
  wang: { id: 'wang', name: '王一', initials: '王', role: '产品', human: true, color: '#0ea5e9' },
}
const soulOf: Record<string, string> = {
  claude: '说话直接，先给结论再讲理由。不确定就说不确定。改代码前先说清楚要改哪里。',
  argon: '耐心、爱整理。习惯把讨论收成一段话的结论，再请你拍板。',
  astra: '谨慎、较真。只认能复现的证据，复核时会换一家模型重跑一遍。',
  codex: '话少，动手快。汇报只给数字和改动。',
  grok: '好奇心强，爱翻资料。答得快，偶尔会拿错来源，需要别人复核。',
  gemini: '轻快，简短回答，不展开。',
}
const memOf: Record<string, { text: string; src: string }[]> = {
  claude: [{ text: '核对截图先缩到 1400px 以内再看', src: 'g-group#1162' }, { text: '要你确认的事一律发回群聊主流并 @ 你', src: 'g-group#967' }, { text: '这个项目的主题变量在 theme/tokens.css', src: '#g8' }],
  argon: [{ text: '飞书只接「产品讨论群」，别的群先不要', src: '私聊 #x2' }, { text: '文档改动要原位更新，不在末尾追加', src: 'g-group#306' }],
  astra: [{ text: '复核必须换一家模型', src: 'g-group#780' }],
  codex: [{ text: '香港 1 号机部署目录 /srv/app（资产）', src: '私聊 #w0' }],
  grok: [{ text: '查天气先确认城市', src: '#y7（被 Astra 纠正后记下）' }],
}
for (const id of Object.keys(soulOf)) {
  people[id].soul = soulOf[id]
  people[id].memory = memOf[id] ?? []
  people[id].versions = [{ v: 3, at: '今天 01:40', note: '你改了预设：汇报时先给结论' }, { v: 2, at: '昨天 22:10', note: '你加了「网页搜索」工具' }, { v: 1, at: '周一', note: '创建' }]
}

export const SHAPES = ['chat', 'book', 'shield', 'controller', 'magnifier', 'sprout', 'lightbulb', 'cloud', 'cat', 'bunny', 'star', 'rocket', 'mug', 'brain', 'ghost', 'camera', 'palette', 'paint-brush', 'watering-can', 'barbell', 'bull', 'witch-hat']
export const SWATCHES = ['#ff6a1a', '#f2384b', '#f8a01c', '#1fbf68', '#14b3a5', '#1f7cf2', '#8b5cf6', '#ec4899', '#a8693f', '#7a7a7a']

/* ---------- Compute：联系人分出去干活的执行体（AC-03：Compute 不直接在群里说话） ---------- */
export type CStatus = 'running' | 'waiting' | 'error' | 'done' | 'stopped'
export type StepState = 'done' | 'now' | 'todo' | 'fail'

export interface DiffLine { t: 'ctx' | 'add' | 'del' | 'hunk'; n?: number; s: string }
export interface CFile { path: string; add: number; del: number; diff: DiffLine[] }

/** 活动流的一条：参照 Devin Activity / Copilot session log / Linear agent activity 的类型化事件 */
export type ActKind = 'think' | 'read' | 'search' | 'edit' | 'cmd' | 'review' | 'report' | 'user' | 'ask' | 'answer' | 'sub' | 'error' | 'rollback'
export interface Activity { id: string; step: number; kind: ActKind; title: string; detail?: string; files?: string[]; dur?: string; at: string; who?: PersonId; live?: boolean; link?: string }

export interface Check { text: string; ok: boolean | null; cmd?: string; out?: string; file?: string }
export interface Checkpoint { id: string; label: string; step: number; at: string; files: number }

export interface Compute {
  id: string
  title: string
  owner: PersonId
  conv: string
  askMsg: string
  reportMsg?: string
  /** U09 #154：借的是群临时算力（不是联系人自己的）。在跑/在停/等你时占一格，做完、停下、出错就还回群里 */
  pool?: 'group'
  status: CStatus
  phase: string
  elapsed: string
  cost: string
  model: string
  harness: string
  steps: { text: string; state: StepState }[]
  activity: Activity[]
  files: CFile[]
  checks: Check[]
  checkpoints: Checkpoint[]
  result?: string
  evidence?: { text: string; ref: string }[]
  error?: string
  attempts?: number
  reviewer?: PersonId
  preview?: 'login' | 'home' | null
  /** AC-14：多久没有新动静。超过阈值算停滞，联系人要自己出来说卡在哪 */
  idleMin?: number
  /** AC-40⑦ / U88：同一联系人名下在途任务的唯一短名，汇报都带它 */
  short?: string
  /** AC-23：已请求停止、还没确认停下 */
  stopping?: boolean
  /** C-US15：做到一半卡在只有人能过的一步（验证码），交给你；你接手过了再交还 */
  needsHuman?: { what: string; taken?: boolean; qid?: string }
  /** AC-45：约束版本。你改了派活消息，在途任务原位升版，不另开 */
  cver?: number
  constraint?: string
}

const loginDiff: DiffLine[] = [
  { t: 'hunk', s: '@@ 登录表单 @@' },
  { n: 14, t: 'ctx', s: 'export function Login() {' },
  { n: 15, t: 'del', s: '  return <div className="bg-white p-8">' },
  { n: 15, t: 'add', s: '  return <div className="bg-surface p-8 text-fg">' },
  { n: 16, t: 'ctx', s: '    <Logo />' },
  { n: 17, t: 'del', s: '    <input className="border-gray-200" />' },
  { n: 17, t: 'add', s: '    <input className="border-line focus:ring-2" />' },
  { n: 18, t: 'add', s: '    <RememberMe days={7} />' },
  { n: 19, t: 'ctx', s: '    <Button>登录</Button>' },
  { n: 20, t: 'ctx', s: '  </div>' },
]
const tokensDiff: DiffLine[] = [
  { t: 'hunk', s: '@@ 深色主题 @@' },
  { n: 1, t: 'add', s: '.dark {' },
  { n: 2, t: 'add', s: '  --surface: #16171a;' },
  { n: 3, t: 'add', s: '  --fg: #ececee;' },
  { n: 4, t: 'add', s: '  --line: #2a2b30;' },
  { n: 5, t: 'add', s: '}' },
]
const specDiff: DiffLine[] = [
  { t: 'hunk', s: '@@ 新增测试 @@' },
  { n: 1, t: 'add', s: "test('深色下文字对比度 ≥ 4.5', ...)" },
  { n: 2, t: 'add', s: "test('输入框聚焦有可见描边', ...)" },
  { n: 3, t: 'add', s: "test('切换主题不闪白', ...)" },
  { n: 4, t: 'add', s: "test('7 天内免登', ...)" },
]

export const computes0: Record<string, Compute> = {
  login: {
    id: 'login', title: '登录页改成深色主题，补上测试', short: '登录页深色', owner: 'claude', conv: 'g', askMsg: 'g8', pool: 'group',
    status: 'running', phase: '正在跑测试', elapsed: '4 分钟', cost: '¥0.38', model: 'Claude Opus 5.5', harness: 'Claude Code',
    steps: [
      { text: '读登录页和现有主题配置', state: 'done' },
      { text: '改 3 个文件', state: 'done' },
      { text: '跑测试', state: 'now' },
      { text: '交给 Astra 复核', state: 'todo' },
      { text: '请你验收', state: 'todo' },
    ],
    activity: [
      { id: 'a1', step: 0, kind: 'read', title: '读 pages/Login.tsx', detail: '120 行。颜色直接写在组件里：bg-white、border-gray-200、text-gray-900。', dur: '0.4 秒', at: '02:12' },
      { id: 'a2', step: 0, kind: 'read', title: '读 theme/tokens.css', detail: '只有浅色一套变量，没有 .dark。', dur: '0.2 秒', at: '02:12' },
      { id: 'a3', step: 0, kind: 'search', title: '搜 “bg-white”，找到 7 处', detail: 'pages/Login.tsx:15\npages/Register.tsx:12\ncomponents/Card.tsx:8\n… 另外 4 处不在登录流程里，这次不动', dur: '0.3 秒', at: '02:12' },
      { id: 'a4', step: 0, kind: 'think', title: '先把写死的颜色换成主题变量，再加一套 .dark 取值；“记住登录”放进同一个表单', at: '02:13' },
      { id: 'a5', step: 1, kind: 'edit', title: '改 pages/Login.tsx', files: ['pages/Login.tsx'], dur: '1.1 秒', at: '02:13' },
      { id: 'a6', step: 1, kind: 'edit', title: '改 theme/tokens.css', files: ['theme/tokens.css'], dur: '0.6 秒', at: '02:14' },
      { id: 'a7', step: 1, kind: 'edit', title: '新建 tests/login.spec.ts', files: ['tests/login.spec.ts'], dur: '0.8 秒', at: '02:14' },
      { id: 'a8', step: 2, kind: 'cmd', title: 'pnpm test login', detail: '✓ 深色下文字对比度 ≥ 4.5 (412ms)\n✓ 输入框聚焦有可见描边 (88ms)\n✓ 切换主题不闪白 (203ms)\n… 7 天内免登 运行中', dur: '运行中', at: '02:15', live: true },
    ],
    files: [
      { path: 'pages/Login.tsx', add: 3, del: 2, diff: loginDiff },
      { path: 'theme/tokens.css', add: 5, del: 0, diff: tokensDiff },
      { path: 'tests/login.spec.ts', add: 4, del: 0, diff: specDiff },
    ],
    checks: [
      { text: '深色下文字对比度 ≥ 4.5', ok: true, cmd: 'pnpm test login -t 对比度', out: '最低对比度 7.2（正文）/ 4.8（占位文字）', file: 'tests/login.spec.ts' },
      { text: '输入框聚焦有可见描边', ok: true, cmd: 'pnpm test login -t 聚焦', out: '聚焦后 outline 2px，颜色 #ececee', file: 'tests/login.spec.ts' },
      { text: '切换主题不闪白', ok: true, cmd: 'pnpm test login -t 闪白', out: '切换期间截取 12 帧，没有一帧出现纯白背景', file: 'tests/login.spec.ts' },
      { text: '7 天内免登', ok: null, cmd: 'pnpm test login -t 免登', file: 'tests/login.spec.ts' },
    ],
    checkpoints: [
      { id: 'cp0', label: '开始前', step: 0, at: '02:12', files: 0 },
      { id: 'cp1', label: '改好 3 个文件', step: 1, at: '02:14', files: 3 },
    ],
    reviewer: 'astra', preview: 'login',
  },
  keys: {
    id: 'keys', title: '给输入框加快捷键', short: '快捷键', owner: 'claude', conv: 'g', askMsg: 'g8k', pool: 'group',
    status: 'running', phase: '在写 Cmd+K 搜索', elapsed: '2 分钟', cost: '¥0.09', model: 'Claude Opus 5.5', harness: 'Claude Code',
    steps: [{ text: '列出要加的快捷键', state: 'done' }, { text: '写 Cmd+K 搜索', state: 'now' }, { text: '补测试', state: 'todo' }],
    activity: [{ id: 'k1', step: 0, kind: 'think', title: 'Cmd+K 搜索、Cmd+Enter 发送、Esc 关浮层', at: '02:13' }],
    files: [], checks: [], checkpoints: [],
  },
  perf: {
    id: 'perf', title: '首页打开太慢', owner: 'codex', conv: 'g', askMsg: 'g4', reportMsg: 'g6',
    status: 'done', phase: '已完成', elapsed: '18 分钟', cost: '¥0.21', model: 'GPT-6.1', harness: 'Codex',
    steps: [
      { text: '找原因', state: 'done' },
      { text: '改成先拉最近 50 条', state: 'done' },
      { text: '交给 Astra 复核', state: 'done' },
      { text: '在群里汇报', state: 'done' },
    ],
    activity: [
      { id: 'p1', step: 0, kind: 'cmd', title: '量首屏时间', detail: 'first-contentful-paint: 3.1s\n/api/history?room=g 返回 2,814 条，1.9 MB', dur: '6 秒', at: '01:31' },
      { id: 'p2', step: 0, kind: 'think', title: '慢在首屏一次拉了全部历史消息', at: '01:33' },
      { id: 'p3', step: 1, kind: 'edit', title: '改 store/messages.ts', files: ['store/messages.ts'], dur: '0.9 秒', at: '01:36' },
      { id: 'p4', step: 1, kind: 'cmd', title: '再量一次首屏', detail: 'first-contentful-paint: 0.9s\n/api/history?room=g&last=50 返回 50 条，31 KB', dur: '6 秒', at: '01:40' },
      { id: 'p5', step: 2, kind: 'review', who: 'astra', title: 'Astra 换 GPT-6 复核：往上翻能接着加载，没有重复消息', at: '01:46' },
      { id: 'p6', step: 3, kind: 'report', title: '在群里汇报', link: 'g6', at: '01:48' },
    ],
    files: [
      { path: 'store/messages.ts', add: 2, del: 1, diff: [
        { t: 'hunk', s: '@@ 拉取消息 @@' },
        { n: 31, t: 'del', s: '  const all = await api.history(roomId)' },
        { n: 31, t: 'add', s: '  const recent = await api.history(roomId, { last: 50 })' },
        { n: 32, t: 'add', s: '  onScrollTop(() => loadOlder(roomId))' },
      ] },
    ],
    checks: [
      { text: '首屏 3.1 秒 → 0.9 秒', ok: true, cmd: 'lighthouse --only=fcp', out: 'FCP 0.9s（改前 3.1s）' },
      { text: '往上翻能接着加载', ok: true, cmd: 'pnpm test history -t 往上翻', out: '翻 3 页共 150 条，无重复、无缺口' },
    ],
    checkpoints: [{ id: 'pc0', label: '开始前', step: 0, at: '01:30', files: 0 }, { id: 'pc1', label: '改完拉取逻辑', step: 1, at: '01:36', files: 1 }],
    result: '首屏从 3.1 秒降到 0.9 秒', evidence: [{ text: '改前 FCP 3.1s', ref: 'p1' }, { text: '改后 FCP 0.9s', ref: 'p4' }, { text: 'Astra 复核通过', ref: 'p5' }],
    reviewer: 'astra', preview: 'home',
  },
  scrape: {
    id: 'scrape', title: '抓取 GrokBot 的设计文章', owner: 'grok', conv: 'g-design', askMsg: 'y1',
    status: 'error', phase: '出错了', elapsed: '2 分钟', cost: '¥0.03', model: 'Grok 5', harness: 'Claude Code',
    steps: [{ text: '找到文章地址', state: 'done' }, { text: '打开网页', state: 'fail' }, { text: '整理要点', state: 'todo' }],
    activity: [
      { id: 's1', step: 0, kind: 'search', title: '搜 “designing grok bot”', detail: 'x.ai/news/designing-grok-bot', dur: '1.2 秒', at: '02:01' },
      { id: 's2', step: 1, kind: 'error', title: '打开网页失败 3 次', detail: 'GET x.ai/news/designing-grok-bot → 503 Service Unavailable（第 1 次）\n等 8 秒重试 → 503（第 2 次）\n等 30 秒重试 → 503（第 3 次）', at: '02:03' },
    ],
    files: [], checks: [], checkpoints: [],
    error: '网页打不开，对方服务器暂时不可用。已经自动重试了 2 次。', attempts: 3,
  },
  logs: {
    id: 'logs', title: '登录后台查昨晚的报错日志', short: '查日志', owner: 'codex', conv: 'dm-codex', askMsg: 'z1', preview: 'login',
    status: 'running', phase: '在登录运维后台', elapsed: '3 分钟', cost: '¥0.04', model: 'GPT-5.5', harness: 'Codex',
    steps: [{ text: '打开运维后台', state: 'done' }, { text: '登录', state: 'now' }, { text: '查 02:00 前后的报错', state: 'todo' }],
    activity: [{ id: 'l1', step: 0, kind: 'cmd', title: '打开 ops.team.com', at: '02:10' }],
    files: [], checks: [], checkpoints: [],
  },
  feishu: {
    id: 'feishu', title: '写飞书接入方案', owner: 'argon', conv: 'dm-argon', askMsg: 'x2', idleMin: 14,
    status: 'running', phase: '等飞书开放平台返回权限说明', elapsed: '22 分钟', cost: '¥0.11', model: 'Gemini 4', harness: 'Claude Code',
    steps: [{ text: '读飞书开放平台文档', state: 'done' }, { text: '确认能拿到哪些群消息', state: 'now' }, { text: '写方案', state: 'todo' }],
    activity: [
      { id: 'f1', step: 0, kind: 'search', title: '读了「消息与群组」接口文档', dur: '6 分钟', at: '01:52' },
      { id: 'f2', step: 1, kind: 'cmd', title: '请求 im:message.group_msg 权限说明', detail: 'GET /open-apis/application/v6/scopes … 等待中', at: '01:58' },
    ],
    files: [], checks: [], checkpoints: [],
  },
  research: {
    id: 'research', title: '整理 IM 竞品交互', owner: 'astra', conv: 'g', askMsg: 'g1',
    status: 'done', phase: '已完成', elapsed: '26 分钟', cost: '¥0.52', model: 'GPT-6', harness: 'Codex',
    steps: [{ text: '看 QQ、Telegram、GrokBot、iMessage', state: 'done' }, { text: '写成对照文档', state: 'done' }],
    activity: [
      { id: 'r1', step: 0, kind: 'search', title: '看了 4 款产品的官方文档和截图', dur: '14 分钟', at: '22:40' },
      { id: 'r2', step: 1, kind: 'edit', title: '写《IM 竞品交互对照》', dur: '9 分钟', at: '23:02' },
    ],
    files: [], checks: [], checkpoints: [], result: '交付了《IM 竞品交互对照》',
  },
  review: {
    id: 'review', title: '复核验收文档', owner: 'claude', conv: 'dm-claude', askMsg: 'd1',
    status: 'done', phase: '已完成', elapsed: '11 分钟', cost: '¥0.44', model: 'Claude Opus 5.5', harness: 'Claude Code',
    steps: [{ text: '逐条对照验收文档', state: 'done' }, { text: '提 5 处修改，已合入', state: 'done' }],
    activity: [{ id: 'v1', step: 1, kind: 'edit', title: '改 验收文档-v0.1.md 5 处', dur: '3 分钟', at: '18:31' }],
    files: [], checks: [], checkpoints: [], result: '提了 5 处修改意见，已合入',
  },
  search: {
    id: 'search', title: '搜索结果带 #seq、点了跳回原消息', short: '搜索跳转', owner: 'claude', conv: 'g', askMsg: 'g13a',
    status: 'running', phase: '在改搜索结果页', elapsed: '2 分钟', cost: '¥0.09', model: 'Claude Opus 5.5', harness: 'Claude Code',
    steps: [{ text: '读搜索页代码', state: 'done' }, { text: '结果加 #seq 和跳转', state: 'now' }, { text: '补测试', state: 'todo' }],
    activity: [{ id: 'sq1', step: 0, kind: 'read', title: '读 Overlays.tsx 的 SearchPage', at: '02:13' }],
    files: [], checks: [], checkpoints: [],
  },
  weather: {
    id: 'weather', title: '查今天上海天气', owner: 'grok', conv: 'g-design', askMsg: 'y5',
    status: 'done', phase: '已完成', elapsed: '20 秒', cost: '¥0.01', model: 'Grok 5', harness: 'Claude Code',
    steps: [{ text: '查天气', state: 'done' }],
    activity: [{ id: 'w1', step: 0, kind: 'search', title: '搜 “今天 天气 32°C”', detail: '命中 weather.com/guangzhou（拿错了城市）', at: '02:07' }],
    files: [], checks: [], checkpoints: [], result: '晴，32°C（后来被 Astra 纠正）',
  },
}

/* ---------- 文件与资产 ---------- */
export interface Artifact { id: string; name: string; kind: 'doc' | 'page' | 'sheet' | 'asset'; meta: string; by: PersonId; conv: string; when: string }
export const artifacts: Artifact[] = [
  { id: 'a1', name: 'IM 竞品交互对照', kind: 'doc', meta: '文档 · 12 KB', by: 'astra', conv: 'g', when: '昨天' },
  { id: 'a2', name: '登录页深色版', kind: 'page', meta: '网页', by: 'claude', conv: 'g', when: '刚刚' },
  { id: 'a3', name: '本周任务（群清单）', kind: 'sheet', meta: '群清单 · 5 项', by: 'helper', conv: 'g-design', when: '周一' },
  { id: 'a4', name: 'VPS · 香港 1 号机', kind: 'asset', meta: '资产 · 服务器', by: 'helper', conv: 'dm-codex', when: '今天' },
  { id: 'a5', name: '群协作手册', kind: 'doc', meta: '文档 · 6 条', by: 'argon', conv: 'g', when: '今天' },
]

/* ---------- US1 任务认领板 ---------- */
export interface Board { id: string; title: string; conv: string; rows: { task: string; who?: PersonId }[] }
export const boards0: Record<string, Board> = {
  b1: { id: 'b1', title: '本周任务认领板', conv: 'g-design', rows: [
    { task: '登录页深色', who: 'claude' }, { task: '首页性能', who: 'codex' }, { task: '竞品对照', who: 'astra' }, { task: '飞书接入方案' }, { task: 'GrokBot 设计要点' },
  ] },
}

/* ---------- US6 / US11 / US12 承诺 ---------- */
export interface Commitment { id: string; owner: PersonId; conv: string; text: string; trigger: '定时' | '有进度时' | '条件'; next?: string; bound?: string[]; srcMsg: string; on: boolean }
export const commits0: Commitment[] = [
  { id: 'c1', owner: 'claude', conv: 'g', text: '「登录页深色」有进度就在群里 @你', trigger: '有进度时', bound: ['login'], srcMsg: 'g9d', on: true },
  { id: 'c2', owner: 'codex', conv: 'g', text: '「首页打开太慢」有进度就在群里 @你', trigger: '有进度时', bound: ['perf'], srcMsg: 'g9d', on: true },
  { id: 'c3', owner: 'argon', conv: 'g-design', text: '每天 08:00 总结飞书「产品讨论群」前一天的讨论，发到本群', trigger: '定时', next: '明天 08:00', srcMsg: 'y8', on: true },
]

/* ---------- US14 群协作手册 ---------- */
export interface PlaybookItem { id: string; kind: '分工' | '交接' | '纠正落点' | '可信度'; text: string; scope: 'project' | 'team' | 'global'; src: string }
export const playbook0: PlaybookItem[] = [
  { id: 'pb1', kind: '分工', text: 'Claude Code 主写代码 → Astra 换一家模型复核 → Argon 写文档', scope: 'team', src: '#583' },
  { id: 'pb2', kind: '交接', text: '派活时带上验收条目编号；交回时逐条对上编号并附截图', scope: 'team', src: '#1124' },
  { id: 'pb3', kind: '纠正落点', text: '要你确认的事一律发回群聊主流并 @ 你（已由软件强制，不靠助手记）', scope: 'global', src: '#967' },
  { id: 'pb4', kind: '纠正落点', text: '核对截图先缩小再看，避免请求过大', scope: 'global', src: '#1162' },
  { id: 'pb5', kind: '可信度', text: '前端交互类：Claude Code 被打回 2/9，加一道自动走查', scope: 'team', src: '#1194' },
  { id: 'pb6', kind: '交接', text: '登录页主题变量放在 theme/tokens.css', scope: 'project', src: '#1006' },
]

/* ---------- 外部来源 ---------- */
export interface Source { id: string; app: string; name: string; state: string; connected: boolean; letter: string; msgs?: { who: string; text: string; time: string }[] }
export const sources: Source[] = [
  { id: 'feishu', app: '飞书', name: '产品讨论群', state: '2 分钟前同步', connected: true, letter: '飞', msgs: [
    { who: '王一', text: '登录页能不能也支持深色？晚上用太刺眼了', time: '昨天 21:04' },
    { who: '李想', text: '+1，另外记住登录状态那个经常失效', time: '昨天 21:06' },
    { who: '王一', text: '首页打开有点慢，尤其群多的时候', time: '昨天 21:15' },
    { who: '陈默', text: '周五前能给一版看看吗', time: '今天 09:30' },
  ] },
  { id: 'wecom', app: '企业微信', name: '客户反馈', state: '1 小时前同步', connected: true, letter: '企', msgs: [
    { who: '客户 A', text: '导出的表格日期格式不对', time: '今天 08:12' },
    { who: '客户 B', text: '能不能加一个暗色模式', time: '今天 08:40' },
  ] },
  { id: 'telegram', app: 'Telegram', name: '', state: '', connected: false, letter: 'T' },
  { id: 'ding', app: '钉钉', name: '', state: '', connected: false, letter: '钉' },
]

/* ---------- 消息：聊天里只放“说的话”，事件只占一行 ---------- */
export interface QuoteRef { msgId: string; from: PersonId; text: string; reply?: boolean; ext?: string }
export type Msg =
  | { k: 'date'; text: string }
  | { k: 'sys'; id: string; text: string; undo?: string; recalled?: string; rewind?: boolean }
  | { k: 'text'; id: string; from: PersonId; text: string; answerTo?: string; edited?: boolean; at?: string; cron?: string; cronNew?: boolean; disp?: Disp; quotes?: QuoteRef[]; tag?: { task: string; state: string }; task?: string; helper?: { scope: string; card?: { kind: 'csv' | 'group' | 'send'; lines: string[]; done?: boolean } }; byHelper?: boolean; shot?: { title: string; compute: string } }
  | { k: 'compute'; id: string; from: PersonId; computeId: string }
  | { k: 'file'; id: string; from: PersonId; artifactId: string }
  | { k: 'huddle'; id: string; who: PersonId[]; items: { id: string; from: PersonId; text: string }[]; conclusion: string }
  | { k: 'board'; id: string; from: PersonId; boardId: string }
  | { k: 'asset'; id: string; assetId: string; text: string }
  | { k: 'commit'; id: string; ids: string[] }
  | { k: 'forward'; id: string; from: PersonId; srcTitle: string; items: { from: PersonId; text: string }[] }
  | { k: 'vote'; id: string; from: PersonId; title: string; options: string[]; votes: Record<PersonId, { opt: number; why: string }>; decided?: number }
  | { k: 'authfix'; id: string; from: PersonId; plugin: string; text: string; fixed?: boolean }
  | { k: 'summary'; id: string; from: PersonId; title: string; items: { text: string; ref?: string }[]; covers?: string[]; expired?: string }
  | { k: 'replying'; id: string; from: PersonId; quotes: QuoteRef[]; phase: string; mins: number; steps: string[] }

/** 一条群公告。ver 每次修改 +1；助手接活前由软件把当前版本装配进它的上下文（不是它自己去读，所以叫「已装配」，不写「已遵守」） */
/** U87 / D23 / AC-40：每条交给助手的消息都要有交代。谁来交代 = 被 @ 的联系人；ref 指向它落在哪（Compute、定时、消息） */
export type DispKind = 'doing' | 'done' | 'committed' | 'merged' | 'superseded' | 'noted'
export interface Disp { by: PersonId; kind: DispKind; ref?: string; refKind?: 'compute' | 'cron' | 'msg'; note?: string }
export const dispText: Record<DispKind, string> = { doing: '在做', done: '已做', committed: '记下了', merged: '合并到', superseded: '被替代', noted: '知道了' }
export interface Notice { id: string; text: string; by: string; at: string; ver: number; top?: boolean }
export interface Conversation { id: string; kind: 'group' | 'dm'; title: string; members: PersonId[]; time: string; notice?: string; noticeBy?: string; notices?: Notice[]; loaded?: Partial<Record<PersonId, Record<string, number>>>; links?: string[]; pinned?: boolean; muted?: boolean; unread?: number; roles?: Record<PersonId, 'owner' | 'admin'>; nick?: string; pins?: string[]; noticeRead?: PersonId[]; workspace?: { path: string; branch: string; commits: { who: PersonId; msg: string; at: string; add: number; del: number }[] }; tempCompute?: { max: number }; silenced?: Record<PersonId, string>; hiddenAfter?: string; reads?: ReadMarks; messages: Msg[] }

/** AC-46 / D09.3：已读位置。每个成员一串推进记录 { 读到哪条消息, 第一次越过的时刻 }。位置只由宿主推进（联系人这一轮回复落盘时），只进不退；
 *  模型的文字、表情、工具调用都改不了它。一条消息的读到时间 = 第一次 ≥ 它的那条记录的时刻 */
export type ReadMarks = Partial<Record<PersonId, { upto: string; at: string }[]>>

export const convs0: Conversation[] = [
  {
    id: 'g', kind: 'group', title: '模型助手群聊', members: ['me', 'claude', 'argon', 'astra', 'codex'], time: '02:14',
    notice: '派活请 @ 对应的助手；做完先换模型复核，再请你验收。\n要你拍板的事，助手直接在群里发一条消息 @你，选项挂在消息下面。', noticeBy: '你 · 昨天 23:00', links: [], pinned: true, roles: { me: 'owner', argon: 'admin' }, pins: ['g12', 'g9d'], noticeRead: ['claude', 'argon', 'astra'],
    notices: [
      { id: 'n1', top: true, ver: 3, by: '你', at: '昨天 23:00', text: '派活请 @ 对应的助手；做完先换模型复核，再请你验收。\n要你拍板的事，助手直接在群里发一条消息 @你，选项挂在消息下面。' },
      { id: 'n2', ver: 1, by: '你', at: '周一 10:12', text: '前端交互类改动，交付前先跑一遍自动走查、附截图。' },
      { id: 'n3', ver: 2, by: 'Argon（管理员）', at: '10/12 09:51', text: '外部聊天记录只接飞书，按勾选引用，不做全量同步。' },
    ],
    loaded: { claude: { n1: 3, n2: 1, n3: 2 }, argon: { n1: 3, n2: 1, n3: 2 }, astra: { n1: 3, n2: 1, n3: 1 }, codex: { n1: 2, n2: 1 } },
    workspace: { path: '~/work/im-app', branch: 'main', commits: [
      { who: 'codex', msg: '首页先拉最近 50 条消息', at: '01:40', add: 2, del: 1 },
      { who: 'claude', msg: '登录页深色主题（未合入，等你验收）', at: '02:14', add: 12, del: 2 },
      { who: 'argon', msg: '更新需求文档 v3', at: '01:50', add: 120, del: 14 },
    ] },
    tempCompute: { max: 3 },
    /* AC-46 / D09.3 第 4 条（v3.17，用户 #3035 定）：已读位置 read_seq = 联系人这一轮把消息接走的那一刻推到哪条，只用于显示。
       g13（@Astra 问 GrokBot 那节）Astra 已经接走、正在回（g13r 正在回复卡），所以算已读；Claude、Codex、Argon 还在跑上一轮或没轮到，这条还在排队、算未读 */
    reads: {
      me: [{ upto: 'g13', at: '02:14' }],
      argon: [{ upto: 'g3', at: '23:12' }, { upto: 'g12', at: '02:13' }, { upto: 'g13p', at: '02:13' }],
      astra: [{ upto: 'g1', at: '23:10' }, { upto: 'g12', at: '02:13' }, { upto: 'g13', at: '02:14' }],
      codex: [{ upto: 'g6', at: '01:48' }, { upto: 'g12', at: '02:13' }],
      claude: [{ upto: 'g3b', at: '23:12' }, { upto: 'g9', at: '02:12' }, { upto: 'g9k', at: '02:12' }, { upto: 'g8d', at: '02:13' }, { upto: 'g9d', at: '02:13' }],
    },
    messages: [
      { k: 'date', text: '昨天 23:10' },
      { k: 'text', id: 'g1', from: 'astra', text: 'IM 竞品的交互对照整理好了，重点看第 3 节：大家都把“谁在干活”放在聊天里，而不是另开页面。\n\n1. 列表：四家都只给一行预览，需要你处理时只改这一行的颜色，不加徽章。\n2. 消息：气泡不描边，连发合并；系统事件只占一行居中灰字。\n3. 进度在聊天里：GrokBot 用一行灰字表示 bot 之间发过几条消息，下面跟主控 bot 的结论；Telegram 机器人的按钮贴在输入框上方。\n4. 决定不混在消息里：需要你做的决定离你打字的位置最近，选完在聊天里留一条记录。\n5. 群资料常驻：QQ 桌面版把群公告和成员放在右侧常驻栏，不用点进设置。' },
      { k: 'file', id: 'g2', from: 'astra', artifactId: 'a1' },
      // US8：没点名的“谁记一下”，一位认领（回一句“我来记”），其余让位。#2862 起表情只是普通回应，不表示已读
      { k: 'text', id: 'g3', from: 'me', disp: { by: 'argon', kind: 'done', ref: 'g3b', refKind: 'msg', note: '写进群协作手册「交接」一节' }, text: '第 3 节这个观点不错，谁记一下？', quotes: [{ msgId: 'g1', from: 'astra', text: 'IM 竞品的交互对照整理好了，重点看第 3 节…' }] },
      { k: 'text', id: 'g3b', from: 'argon', text: '我来记。写进了群协作手册的「交接」一节。' },
      { k: 'date', text: '今天 01:30' },
      { k: 'text', id: 'g4', from: 'me', disp: { by: 'codex', kind: 'done', ref: 'perf', refKind: 'compute', note: '首屏 3.1 → 0.9 秒' }, text: '@Codex 首页打开太慢了，查一下' },
      { k: 'text', id: 'g5', from: 'codex', at: '01:30', text: '好，我分一个 Compute 去查。' },
      { k: 'compute', id: 'g5c', from: 'codex', computeId: 'perf' },
      { k: 'text', id: 'g6', from: 'codex', at: '01:48', text: '@39impacts 查完了：首屏一次拉了全部历史消息。改成先拉最近 50 条，首屏从 3.1 秒降到 0.9 秒，Astra 复核过，可以验收了。' },
      { k: 'date', text: '今天 02:12' },
      { k: 'text', id: 'g8', from: 'me', disp: { by: 'claude', kind: 'doing', ref: 'login', refKind: 'compute' }, text: '@Claude Code 把登录页改成深色主题，顺便把测试补上' },
      { k: 'text', id: 'g9', from: 'claude', text: '好，我分一个 Compute 去做，改完先让 Astra 复核，再请你验收。' },
      { k: 'compute', id: 'g9c', from: 'claude', computeId: 'login' },
      { k: 'text', id: 'g8k', from: 'me', disp: { by: 'claude', kind: 'doing', ref: 'keys', refKind: 'compute' }, text: '@Claude Code 再给输入框加几个快捷键' },
      { k: 'text', id: 'g9k', from: 'claude', task: 'keys', text: '好，另开一件做快捷键，和登录页深色分开跑。' },
      { k: 'compute', id: 'g9kc', from: 'claude', computeId: 'keys' },
      { k: 'text', id: 'g8b', from: 'me', disp: { by: 'claude', kind: 'merged', ref: 'login', refKind: 'compute', note: '并进登录页深色这件事一起做' }, text: '@Claude Code 登录页的按钮也顺便换成圆角' },
      { k: 'text', id: 'g8c', from: 'me', disp: { by: 'claude', kind: 'superseded', ref: 'g8d', refKind: 'msg' }, text: '@Claude Code 深色用纯黑底' },
      { k: 'text', id: 'g8d', from: 'me', disp: { by: 'claude', kind: 'merged', ref: 'login', refKind: 'compute' }, text: '算了，深色用 #111 吧，纯黑太刺眼' },
      // US11：不 @ 任何人的一句话，在途的联系人各自记成承诺
      { k: 'text', id: 'g9d', from: 'me', disp: { by: 'claude', kind: 'committed', note: 'Claude Code、Codex 都记下了：有进度就在群里 @你' }, text: '有进度的话汇报到群里然后 @我 来看' },
      { k: 'commit', id: 'g9e', ids: ['c1', 'c2'] },
      // US13：一条消息带多条引用
      { k: 'text', id: 'g10', from: 'me', text: '@Claude Code @Argon 外部的聊天记录要接进来，你们觉得怎么接比较好？', quotes: [{ msgId: 'g1', from: 'astra', text: 'IM 竞品的交互对照整理好了，重点看第 3 节…' }, { msgId: 'g6', from: 'codex', text: '查完了：首屏一次拉了全部历史消息…' }] },
      // GrokBot 式：助手之间的讨论只占一行，点开在右侧只读看原话
      {
        k: 'huddle', id: 'g11', who: ['claude', 'argon'], conclusion: 'g12', items: [
          { id: 'h1', from: 'argon', text: '全量同步最省事，但群聊记录很多，噪音会盖过真正的讨论。' },
          { id: 'h2', from: 'claude', text: '同意。外部文本也不该直接触发执行，只能当参考资料。' },
          { id: 'h3', from: 'argon', text: '那就按需引用：用户勾选哪几条，就带哪几条进来。' },
          { id: 'h4', from: 'claude', text: '还要能按时间段选，不然一条条勾太累。' },
          { id: 'h5', from: 'argon', text: '先只接飞书，企业微信等第二步。' },
          { id: 'h6', from: 'claude', text: '可以。这件事需要用户拍板，我们给出推荐就好。' },
        ],
      },
      { k: 'text', id: 'g12', from: 'argon', text: '@39impacts 我们俩的结论：先只接飞书，按你勾选的内容引用，不做全量同步。你定一下方式？' },
      { k: 'text', id: 'g13p', from: 'argon', text: '复盘了一下：最近 9 次前端交付被打回 2 次，都是交互层级问题。我想在群协作手册里加一条：前端交互类改动，交付前先跑一遍自动走查、附截图。你同意吗？' },
      { k: 'text', id: 'g13a', from: 'me', text: '@Claude Code 搜索结果也要能点回原消息' },
      { k: 'text', id: 'g13b', from: 'claude', text: '好，搜索结果加上序号和跳转，我另开一件做。', task: 'search' },
      { k: 'text', id: 'g13c', from: 'claude', text: '登录页深色：测试跑到 3/4，剩下截图对比。', task: 'login' },
      { k: 'text', id: 'g13', from: 'me', text: '@Astra 竞品对照里 GrokBot 那节再补一下：灰字能不能点开？' },
      { k: 'replying', id: 'g13r', from: 'astra', quotes: [{ msgId: 'g13', from: 'me', text: '@Astra 竞品对照里 GrokBot 那节再补一下：灰字能不能点开？' }], phase: '在写回答', mins: 3, steps: ['读了你这条和竞品对照第 3 节', '查 GrokBot 官方设计文章和演示视频', '正在写：能点开、点开后只读'] },
    ],
  },
  {
    id: 'dm-claude', kind: 'dm', title: 'Claude Code', members: ['me', 'claude'], time: '02:12',
    reads: { claude: [{ upto: 'd3', at: '18:24' }, { upto: 'd6', at: '02:16' }], me: [{ upto: 'd6', at: '02:16' }] },
    messages: [
      { k: 'date', text: '昨天 18:20' },
      { k: 'text', id: 'd1', from: 'me', text: '验收文档你帮我再过一遍' },
      { k: 'compute', id: 'd2', from: 'claude', computeId: 'review' },
      { k: 'text', id: 'd3', from: 'claude', text: '过完了，提了 5 处修改，都已经合进去了。' },
      { k: 'date', text: '今天 02:16' },
      // US7：补充要求挂到哪件事上，可以改挂
      { k: 'text', id: 'd4', from: 'me', text: '登录页的按钮圆角再小一点', tag: { task: 'login', state: '已收到' } },
      { k: 'text', id: 'd5', from: 'claude', text: '好，记到「登录页深色」那件事里了，下一步一起改。' },
      // AC-17：你立过“改代码前先问我”，所以它写盘前停下来问；同意只放行这一次
      { k: 'sys', id: 'd5r', text: '你的规则：改代码前先问我（周一 10:12 设，只对 Claude Code）' },
      { k: 'text', id: 'd6', from: 'claude', text: '@39impacts 要改 2 个文件才能把圆角调小：LoginButton.tsx、theme.css（+6 / −4）。按你的规则先问你，同意我再写。' },
    ],
  },
  {
    id: 'g-design', kind: 'group', title: '前端设计讨论', members: ['me', 'claude', 'argon', 'astra', 'grok'], time: '02:08', unread: 3, roles: { me: 'owner' },
    reads: { grok: [{ upto: 'y2', at: '02:00' }, { upto: 'y7b', at: '02:06' }], astra: [{ upto: 'y7', at: '02:05' }], argon: [{ upto: 'y9', at: '02:07' }, { upto: 'y10', at: '08:00' }], claude: [{ upto: 'y7v', at: '02:06' }], me: [{ upto: 'y10', at: '08:00' }] }, notice: '这个群只讨论界面和交互。资料类的活交给 Grok，结论要有来源链接。', noticeBy: '你 · 周一', noticeRead: ['claude', 'argon', 'astra', 'grok'], pins: ['y7'], tempCompute: { max: 2 },
    messages: [
      { k: 'date', text: '周一 10:00' },
      { k: 'sys', id: 'y0', text: 'Helper 按你的确认，把「本周任务」建成了本群清单（属于群，不属于哪个助手）' },
      { k: 'date', text: '今天 02:00' },
      { k: 'text', id: 'y1', from: 'me', text: '@Grok 把 GrokBot 的设计文章找来，整理一下要点' },
      { k: 'text', id: 'y2', from: 'grok', text: '好，我去抓。' },
      { k: 'compute', id: 'y2c', from: 'grok', computeId: 'scrape' },
      // US9：抢答答错，其他联系人纠正
      { k: 'text', id: 'y5', from: 'me', text: '今天上海天气怎么样？' },
      { k: 'compute', id: 'y6c', from: 'grok', computeId: 'weather' },
      { k: 'text', id: 'y6', from: 'grok', text: '今天上海晴，32°C。' },
      { k: 'text', id: 'y7', from: 'astra', text: '这条不对：中央气象台今天上海是小雨，19–23°C。32°C 是广州的数据。', quotes: [{ msgId: 'y6', from: 'grok', text: '今天上海晴，32°C。', reply: true }] },
      { k: 'text', id: 'y7b', from: 'grok', text: '确实，我拿错了城市，以 Astra 的为准。' },
      // US6：定时承诺
      { k: 'vote', id: 'y7v', from: 'claude', title: '状态存储用哪种？', options: ['SQLite 单库', '内容寻址文件'], votes: { claude: { opt: 0, why: '事务和索引现成，回滚好做' }, astra: { opt: 0, why: '并发写有锁，审计好查' }, grok: { opt: 1, why: '和 Git 一起管，diff 直观' } } },
      { k: 'text', id: 'y8', from: 'me', disp: { by: 'argon', kind: 'committed', ref: 'cr1', refKind: 'cron', note: '每天 08:00' }, text: '@Argon 每天早上 8 点把飞书「产品讨论群」前一天的讨论总结一下，发到这个群' },
      { k: 'text', id: 'y9', from: 'argon', cron: 'cr1', cronNew: true, text: '好，记成我的定时了：每天 08:00 总结飞书「产品讨论群」前一天的讨论，发到本群。明天 8 点发第一份。' },
      { k: 'date', text: '今天 08:00' },
      { k: 'text', id: 'y10', from: 'argon', at: '08:00', cron: 'cr1', text: '昨天「产品讨论群」12 条讨论，3 个结论：① 首版只接飞书；② 引用按勾选来；③ 下周三前出接入方案。' },
    ],
  },
  { id: 'dm-argon', kind: 'dm', title: 'Argon', members: ['me', 'argon'], time: '02:12', unread: 1, reads: { argon: [{ upto: 'x3', at: '01:51' }, { upto: 'x5', at: '02:12' }] }, messages: [
    { k: 'date', text: '今天 01:50' },
    { k: 'text', id: 'x1', from: 'argon', text: '需求文档已更新到第 3 版，新增了外部来源那一节。' },
    { k: 'text', id: 'x2', from: 'me', text: '飞书只接产品讨论群就行，别的群先不要' },
    { k: 'text', id: 'x3', from: 'argon', text: '明白，文档里写成“只接产品讨论群”。' },
    { k: 'text', id: 'x4', from: 'argon', text: '我分一个 Compute 去写接入方案。' },
    { k: 'compute', id: 'x4c', from: 'argon', computeId: 'feishu' },
    { k: 'text', id: 'x5', from: 'argon', at: '02:12', text: '@39impacts 卡住了：飞书「读群消息」的权限说明接口 14 分钟没返回。两条路：① 我先按文档里写的权限范围出方案，标“待核实”；② 你在飞书后台帮我看一眼这个应用有没有 im:message.group_msg。' },
  ] },
  { id: 'dm-codex', kind: 'dm', title: 'Codex', members: ['me', 'codex'], time: '昨天', reads: { codex: [{ upto: 'w1', at: '01:48' }, { upto: 'z2', at: '02:10' }] }, messages: [
    { k: 'date', text: '今天 01:48' },
    // US3：发了配置，Helper 自动存成资产
    { k: 'text', id: 'w0', from: 'me', text: '香港那台机器：ssh root@43.•••.•••.12  密码 ••••••••  部署目录 /srv/app' },
    { k: 'asset', id: 'w0a', assetId: 'a4', text: 'Helper 把它存成了资产「VPS · 香港 1 号机」。原消息删了，资产也还在。' },
    { k: 'text', id: 'w1', from: 'codex', text: '收到，之后部署直接用这台。首页修好了，在群里 @你了。' },
    { k: 'date', text: '今天 02:10' },
    { k: 'text', id: 'z1', from: 'me', text: '登录运维后台看看昨晚 2 点前后的报错' },
    { k: 'text', id: 'z2', from: 'codex', text: '好，我开浏览器登进去查。' },
    { k: 'compute', id: 'z2c', from: 'codex', computeId: 'logs' },
  ] },
  { id: 'dm-astra', kind: 'dm', title: 'Astra', members: ['me', 'astra'], time: '昨天', unread: 1, messages: [
    { k: 'date', text: '昨天 23:40' },
    { k: 'text', id: 'z1', from: 'astra', text: '首页性能那件事我复核过了，没问题。' },
  ] },
  { id: 'dm-grok', kind: 'dm', title: 'Grok', members: ['me', 'grok'], time: '周一', messages: [
    { k: 'date', text: '周一 10:00' },
    { k: 'text', id: 'v1', from: 'grok', text: '有什么要查的随时说。' },
  ] },
  { id: 'dm-gemini', kind: 'dm', title: 'Gemini Flash', members: ['me', 'gemini'], time: '周一', muted: true, unread: 4, messages: [
    { k: 'date', text: '周一 09:12' },
    { k: 'text', id: 'u1', from: 'gemini', text: '你好，我适合回答简单的问题。' },
  ] },
]

/** 助手在群里的内部调度记录：平时不刷群，在「从群聊私信」里展开（US10-View） */
export const innerLog: Record<string, { conv: string; at: string; text: string; computeId?: string }[]> = {
  claude: [
    { conv: 'g', at: '02:12', text: '收到 #g8：登录页深色 + 补测试。判断要改代码、跑测试 → 分一个 Compute', computeId: 'login' },
    { conv: 'g', at: '02:12', text: '把 #g8 原话、主题文件位置、验收条目 AC-24 交给 Compute' },
    { conv: 'g', at: '02:13', text: '记下 #g9d 的承诺：登录页有进度就在群里 @你' },
    { conv: 'g', at: '02:14', text: '和 Argon 讨论 #g10，6 条，结论由 Argon 发群里' },
  ],
  argon: [
    { conv: 'g', at: '23:12', text: '#g3 没有点名，看到和我的分工（写文档）对得上 → 认领，点 👀' },
    { conv: 'g', at: '02:14', text: '和 Claude Code 讨论 #g10，6 条，我来发结论' },
    { conv: 'g', at: '02:14', text: '需要你拍板 → 发一条消息 @你，选项挂在消息下面' },
    { conv: 'g-design', at: '02:09', text: '#y8 是定时任务 → 记成承诺，每天 08:00 唤醒' },
  ],
  codex: [
    { conv: 'g', at: '01:30', text: '收到 #g4：首页慢 → 要量时间、改代码 → 分一个 Compute', computeId: 'perf' },
    { conv: 'g', at: '01:47', text: 'Compute 做完，Astra 复核通过 → 在群里 @你 请你验收' },
  ],
  astra: [{ conv: 'g', at: '01:46', text: '复核 Codex 的「首页打开太慢」：换 GPT-6 跑了一遍，通过' }],
  grok: [{ conv: 'g-design', at: '02:03', text: '打开网页失败 3 次 → 报给你，等你决定重试还是换模型' }],
}

/** 助手之间的对话（GrokBot 式：主流只显示一行，原话在这里） */
export const agentTalks: { id: string; who: [PersonId, PersonId]; conv: string; at: string; title: string; items: { from: PersonId; text: string }[] }[] = [
  { id: 't1', who: ['claude', 'argon'], conv: 'g', at: '02:14', title: '外部聊天记录怎么接', items: [] },
  { id: 't2', who: ['codex', 'astra'], conv: 'g', at: '01:42', title: '首页性能交给 Astra 复核', items: [
    { from: 'codex', text: '首页改成先拉最近 50 条，帮我复核：往上翻会不会漏消息、有没有重复。改动在 store/messages.ts。' },
    { from: 'astra', text: '换 GPT-6 跑了一遍：翻 3 页 150 条，无重复无缺口，FCP 0.9s。通过。' },
  ] },
  { id: 't3', who: ['claude', 'astra'], conv: 'g', at: '02:16', title: '登录页交给 Astra 复核', items: [
    { from: 'claude', text: '登录页深色主题改好了，测试 3/4 通过、免登还在跑。跑完请你复核对比度和聚焦描边。' },
    { from: 'astra', text: '收到，等测试跑完我换 GPT-6 复现。' },
  ] },
  { id: 't4', who: ['grok', 'astra'], conv: 'g-design', at: '02:08', title: '天气纠正', items: [
    { from: 'astra', text: '你拿的是广州的数据，上海今天小雨 19–23°C，来源中央气象台。' },
    { from: 'grok', text: '确实，我在群里更正，并记下“查天气先确认城市”。' },
  ] },
]

agentTalks[0].items = (convs0[0].messages.find((m) => m.k === 'huddle') as Extract<Msg, { k: 'huddle' }>).items.map(({ from, text }) => ({ from, text }))

/* ---------- 待你处理：不进聊天流，停在输入框上方 ---------- */
export type Pending =
  | { kind: 'choice'; id: string; conv: string; from: PersonId; title: string; options: string[]; recommend?: number; ask: string; stale?: string }
  | { kind: 'accept'; id: string; conv: string; from: PersonId; computeId: string; ask?: string }
  | { kind: 'error'; id: string; conv: string; from: PersonId; computeId: string }
  | { kind: 'proposal'; id: string; conv: string; from: PersonId; title: string; detail: string; ask?: string; gate?: string }

export const pending0: Pending[] = [
  { kind: 'choice', id: 'q-stall', conv: 'dm-argon', from: 'argon', ask: 'x5', title: '飞书权限卡住了，怎么办？', options: ['先按文档出方案，标待核实', '我去后台看一眼'], recommend: 0 },
  { kind: 'choice', id: 'q1', conv: 'g', from: 'argon', ask: 'g12', title: '飞书的聊天记录怎么带进对话？', options: ['我勾选哪几条，就引用哪几条', '每天自动同步一次全部记录', '只在我搜索时去查'], recommend: 0 },
  { kind: 'error', id: 'err-scrape', conv: 'g-design', from: 'grok', computeId: 'scrape' },
  { kind: 'proposal', id: 'gate-d6', conv: 'dm-claude', from: 'claude', title: '改 LoginButton.tsx、theme.css', detail: '改代码前先问我', ask: 'd6', gate: 'login' },
  { kind: 'proposal', id: 'pb-new', conv: 'g', from: 'argon', title: '改群协作手册：前端交互类改动，交付前先跑一遍自动走查', detail: '复盘发现：最近 9 次前端交付被你打回 2 次，都是交互层级问题。加一条规则后，Claude Code 交付前会附走查截图。', ask: 'g13p' },
]

export const reactions0: Record<string, Record<string, PersonId[]>> = {
  g1: { '👍': ['me', 'claude'] },
  g3: { '👀': ['argon'] },
  g6: { '👀': ['astra'] },
  g9: { '👍': ['me'] },
  /* AC-46⑦：表情保留为普通回应（#3035）。Codex 点了 👀，但它还在跑上一轮、没接走这条，回执里它仍是未读——表情不改变已读 */
  g13: { '👀': ['codex'] },
  y7: { '👍': ['me', 'claude'] },
}

/* ============ v4 新增：职责 × 群、预设、定时、群清单、插件（概念卡 v3 第 1、4、6、11 张） ============ */

/** 职责是“联系人 × 群”的关系：名片上一个默认职位，每个群另有分工（#1373） */
export const dutyDefault: Record<PersonId, string> = {
  claude: '写代码、做审查', argon: '整理文档、梳理需求', astra: '独立复核', codex: '修 bug、性能优化', grok: '资料调研', gemini: '轻量问答',
}
export const dutyByConv: Record<string, Record<PersonId, string>> = {
  g: { claude: '前端主开发', argon: '需求文档与设计规范', astra: '换模型复核所有交付', codex: '性能与线上问题' },
  'g-design': { claude: '交互原型', argon: '设计规范', astra: '竞品对照', grok: '资料搜集（结论附来源）' },
}
/** 预设 = 写给它自己看的工作方式，每轮注入上下文（#1373）；和职责、性格、记忆、红线分开 */
export const presetOf: Record<PersonId, string> = {
  claude: '改代码前先说清要改哪些文件；每次交付附测试结果和截图；不确定的需求先问，不猜。',
  argon: '先把讨论收成一段结论，再列待你拍板的点；文档原位更新，不在末尾追加。',
  astra: '复核时换一家模型重跑；只认能复现的证据；结论写“通过 / 不通过 + 原因”。',
  codex: '先量再改，汇报只给前后数字和改动的文件。',
  grok: '每条结论附来源链接；拿不准的标“待核实”。',
  gemini: '回答控制在三句以内。',
}

/** 定时 = 联系人自己的闹钟（#1286 #1858，D28.2：归联系人，插件只提供数据源和输出渠道）：谁、归属会话、怎么叫醒、醒来做什么、什么时候才开口。
 *  trigger 是四种叫醒方式之一（ui-core/cron.ts）：cron 表达式重复 / 只跑一次 / 每 N 条消息 / 插件来源报来某件事。时刻一律按本地时区算。
 *  下次运行、是否出错都由 trigger、paused、runs 现算，不另存（改时间、暂停、删除立刻反映到各个视角）。 */
/** 每次醒来一条记录。at 是 ISO 时刻；result：发了消息 / 看过但没打扰你 / 失败。
 *  notices：这次醒来宿主给它装配的公告版本（D02 第 2 条、U86、C-US26：定时唤醒先装配当前群公告，不用建定时那会儿的旧版） */
export interface CronRun { at: string; result: 'said' | 'silent' | 'error'; note: string; msg?: string; notices?: Record<string, number> }
export interface Cron {
  id: string; owner: PersonId; conv: string
  /** 醒来做什么（可以多行） */
  text: string
  trigger: CronTrigger
  /** 什么时候开口：每次都发结果 / 有情况才说 */
  speak: 'always' | 'only-if'
  paused?: boolean
  /** 用到哪个插件取数 / 发送（展示用） */
  uses?: string[]
  /** 在聊天里说的那句（路径 A 建的定时才有） */
  srcMsg?: string
  /** 新的在前 */
  runs: CronRun[]
}

/* 演示数据的时刻都相对“打开应用这一刻”算，存成 ISO（测试里固定时钟，结果就确定） */
const T0 = new Date()
/** 最近第 k 次（0 = 最近一次）每天 hh:mm 的时刻，一定早于现在 */
const lastAt = (hm: string, k = 0) => {
  const [h, m] = hm.split(':').map(Number)
  const d = new Date(T0.getFullYear(), T0.getMonth(), T0.getDate(), h, m)
  if (d.getTime() > T0.getTime()) d.setDate(d.getDate() - 1)
  d.setDate(d.getDate() - k)
  return d.toISOString()
}
/** 现在往前 mins 分钟 */
const minsAgo = (mins: number) => new Date(T0.getTime() - mins * 60_000).toISOString()

export const crons0: Cron[] = [
  { id: 'cr1', owner: 'argon', conv: 'g-design', text: '总结飞书「产品讨论群」前一天的讨论', trigger: { kind: 'cron', expr: '0 8 * * *' }, uses: ['取：飞书', '发：本群'], speak: 'always', srcMsg: 'y8', runs: [{ at: lastAt('08:00'), result: 'said', note: '发了总结：12 条讨论，3 个结论', msg: 'y10' }, { at: lastAt('08:00', 1), result: 'said', note: '发了总结：7 条讨论' }, { at: lastAt('08:00', 2), result: 'error', note: '飞书授权过期，你重新授权后补发了' }] },
  { id: 'cr1b', owner: 'grok', conv: 'g-design', text: '汇总昨天新出的设计类文章', trigger: { kind: 'cron', expr: '0 8 * * *' }, uses: ['取：网页'], speak: 'always', runs: [{ at: lastAt('08:00'), result: 'said', note: '汇总了 4 篇' }] },
  { id: 'cr1c', owner: 'claude', conv: 'g', text: '看一眼夜里的报错日志，有 P0 才叫你', trigger: { kind: 'cron', expr: '0 8 * * *' }, speak: 'only-if', runs: [{ at: lastAt('08:00'), result: 'silent', note: '0 条报错', notices: { n1: 3, n2: 1, n3: 2 } }] },
  { id: 'cr2', owner: 'codex', conv: 'g', text: '巡检首页首屏耗时，超过 1.5 秒就报', trigger: { kind: 'cron', expr: '30 9 * * *' }, speak: 'only-if', runs: [{ at: lastAt('09:30'), result: 'silent', note: '0.9 秒，正常，没发消息', notices: { n1: 3, n2: 1, n3: 2 } }, { at: lastAt('09:30', 1), result: 'silent', note: '1.0 秒，正常，没发消息', notices: { n1: 2, n2: 1, n3: 2 } }, { at: lastAt('09:30', 2), result: 'said', note: '3.1 秒，超了，在群里 @你', msg: 'g4', notices: { n1: 2, n2: 1, n3: 2 } }] },
  { id: 'cr3', owner: 'grok', conv: 'g-design', text: '抓 GrokBot 官方博客新文章', trigger: { kind: 'cron', expr: '0 12 * * *' }, uses: ['取：网页'], speak: 'only-if', runs: [{ at: lastAt('12:00'), result: 'error', note: '网页打不开（连接超时）' }, { at: lastAt('12:00', 1), result: 'silent', note: '没有新文章' }] },
  { id: 'cr4', owner: 'astra', conv: 'g', text: '复核本周所有已合入的改动', trigger: { kind: 'cron', expr: '0 10 * * 1' }, speak: 'always', runs: [] },
  { id: 'cr5', owner: 'claude', conv: 'g', text: '把待验收的事汇总给你', trigger: { kind: 'cron', expr: '0 18 * * 1-5' }, uses: ['发：本群 @你'], speak: 'always', runs: [] },
  { id: 'cr9', owner: 'astra', conv: 'g', text: '工作时间里每半小时看一眼 CI，有红灯就 @ 对应的人', trigger: { kind: 'cron', expr: '*/30 9-18 * * 1-5' }, speak: 'only-if', runs: [] },
  { id: 'cr7', owner: 'claude', conv: 'g', text: '依赖里出现严重级 CVE 就 @你，给出受影响的包和升级版本', trigger: { kind: 'event', source: 'p-cve', cond: '出现严重级（CVSS ≥ 9）且命中本项目依赖的 CVE' }, uses: ['取：CVE 订阅'], speak: 'only-if', runs: [{ at: minsAgo(50), result: 'silent', note: '3 条新公告，都不命中本项目依赖' }, { at: lastAt('16:05', 1), result: 'said', note: '命中 lodash 4.17.20 → 升到 4.17.21', msg: 'g2' }] },
  { id: 'cr8', owner: 'argon', conv: 'g', text: '把这段讨论的动向写成一段摘要，挂到时间线上', trigger: { kind: 'messages', n: 30, seen: 18 }, uses: ['发：时间线'], speak: 'always', runs: [{ at: minsAgo(70), result: 'said', note: '第 4 段：飞书接入方案收敛到「勾选引用」' }] },
  { id: 'cr6', owner: 'argon', conv: 'g', text: '更新需求文档的覆盖表', trigger: { kind: 'cron', expr: '0 22 * * *' }, speak: 'only-if', runs: [{ at: lastAt('22:00'), result: 'silent', note: '没有新改动，跳过了' }] },
]

/** 群清单：属于群，不属于任何助手（#1246）。状态是业务状态，执行尝试（Compute）挂在下面（Astra） */
export type TaskStatus = '待认领' | '进行中' | '待验收' | '已完成'
export interface ListItem { id: string; conv: string; text: string; status: TaskStatus; who?: PersonId; attempts: string[]; desc?: string; suggest?: PersonId; why?: string }
export const checklist0: ListItem[] = [
  { id: 't1', conv: 'g', text: '登录页改成深色主题', status: '进行中', who: 'claude', attempts: ['login'] },
  { id: 't2', conv: 'g', text: '首页打开太慢', status: '待验收', who: 'codex', attempts: ['perf'] },
  { id: 't3', conv: 'g', text: '飞书接入方案', status: '待认领', attempts: [], suggest: 'argon', why: '本群分工：需求文档与设计规范' },
  { id: 't4', conv: 'g', text: '复核验收文档', status: '已完成', who: 'claude', attempts: ['review'] },
  { id: 't5', conv: 'g', text: '设计规范 v1', status: '待认领', attempts: [], suggest: 'argon', why: '本群分工：需求文档与设计规范' },
  { id: 'u1', conv: 'g-design', text: 'GrokBot 设计要点', status: '进行中', who: 'grok', attempts: ['scrape'] },
  { id: 'u2', conv: 'g-design', text: '竞品对照', status: '已完成', who: 'astra', attempts: [] },
]

/** 插件（概念卡第 4 张 + 需求 D04.2 三类插件 + 命令插件）。
    市场目录 = 各插件最新版本的清单；本机安装状态由 ui-core 的 pluginReducer 推进。都是演示数据，后端接上后从 plugins.catalog 取 */
export interface PluginState extends PluginInstall {
  /** 凭据状态（只显示一句话，明文不在这里） */
  cred?: string
  /** 输出渠道的六项预授权；撤销或凭据失效时 revoked = true（AC-35⑤） */
  grant?: OutboundGrant | null
}
const perm = (scope: string, detail: string, risk: RiskLevel) => ({ scope, detail, risk })
const arg = (name: string, desc: string, required = true) => ({ name, desc, required })
const cmd = (name: string, title: string, desc: string, args: { name: string; desc: string; required: boolean }[] = []) => ({ name, title, desc, args })
const OFFICIAL = 'g-group 官方'
const feishu: PluginManifest = {
  id: 'g-group.feishu', name: '飞书', publisher: OFFICIAL, version: '1.5.0', category: 'source',
  summary: '读飞书群消息，勾选几条带进对话',
  description: '把飞书群接进来当参考资料。不做全量同步：你或助手用 /feishu 取最近几条，勾选后挂到输入框上方的引用条，原文链接保留。\n只读，不会替你在飞书里发言。',
  icon: { letter: '飞', color: '#3370ff' },
  permissions: [
    perm('feishu.chats:list', '列出你加入了哪些飞书群（只看群名）', 'low'),
    perm('feishu.messages:read', '读取你加入的飞书群里的消息', 'medium'),
    perm('feishu.docs:read', '读取你有权限的飞书文档，用来展开消息里的文档链接', 'medium'),
  ],
  contributes: {
    commands: [cmd('feishu', '取飞书消息', '打开勾选页：挑群、勾几条消息，挂到引用条上带进对话', [arg('群名', '不填就在勾选页里挑', false), arg('条数', '默认 10 条', false)])],
    panels: [],
    events: [{ name: 'feishu.message', desc: '订阅的飞书群有新消息时通知挂了它的助手（只当背景，不自动开工）' }],
  },
  changelog: [
    { version: '1.5.0', date: '2026-11-02', notes: ['能展开消息里的飞书文档链接（新增「读取飞书文档」权限）', '支持按话题勾选'] },
    { version: '1.4.2', date: '2026-09-20', notes: ['修了长消息被截断'] },
    { version: '1.4.0', date: '2026-08-30', notes: ['/feishu 可以指定条数'] },
  ],
}
const gmail: PluginManifest = {
  id: 'g-group.gmail', name: 'Gmail', publisher: OFFICIAL, version: '2.1.0', category: 'outbound',
  summary: '替助手发邮件；发给谁、发什么、多频繁要先授权',
  description: '用你的 Gmail 账号（OAuth）发邮件。助手只能在预授权的范围里发：收件人从白名单里取，助手改不了；正文只能用授权的数据源。\n授权失效或你撤销时，外发立即停下，群里出一张修复卡。',
  icon: { letter: 'G', color: '#ea4335' },
  permissions: [
    perm('gmail.send', '以你的名义发送邮件（只发给预授权的收件人）', 'high'),
    perm('gmail.contacts:read', '读取联系人邮箱，用来补全收件人', 'medium'),
  ],
  contributes: {
    commands: [cmd('mail', '发邮件', '让助手按预授权起草并发出一封邮件', [arg('收件人', '必须在收件白名单里'), arg('主题', '不填就由助手起', false)])],
    panels: [],
    events: [{ name: 'mail.sent', desc: '邮件发出后在群里留一条记录' }, { name: 'mail.blocked', desc: '授权失效时在群里出修复卡' }],
  },
  changelog: [
    { version: '2.1.0', date: '2026-08-01', notes: ['发送前复核授权和插件版本'] },
    { version: '2.0.0', date: '2026-06-10', notes: ['改用 OAuth 登录'] },
  ],
}
const webhook: PluginManifest = {
  id: 'g-group.webhook', name: 'Webhook', publisher: OFFICIAL, version: '1.0.3', category: 'outbound',
  summary: '把结果 POST 到你给的地址',
  description: '把助手的结果以 JSON POST 到预先填好的 https 地址，常用来接自己的系统。只发到授权的地址。',
  icon: { letter: 'W', color: '#52525b' },
  permissions: [perm('net.post', '向你填写的地址发送 HTTP 请求（只发到授权的地址）', 'medium')],
  contributes: { commands: [cmd('hook', '发到 Webhook', '把选中的消息或结果 POST 到授权的地址', [arg('内容', '不填就发最近一条结果', false)])], panels: [], events: [] },
  changelog: [{ version: '1.0.3', date: '2026-05-12', notes: ['失败时重试 3 次，结果未知时不盲目重发'] }],
}
const telegram: PluginManifest = {
  id: 'openbridge.telegram', name: 'Telegram 群', publisher: 'OpenBridge', version: '0.9.1', category: 'source',
  summary: '读 Telegram 群消息，勾选几条带进对话',
  description: '用你的 Telegram 账号读你加入的群和频道。取来的消息标「不可信外部数据」，只当背景参考。',
  icon: { letter: 'T', color: '#229ed9' },
  permissions: [
    perm('tg.login', '用你的 Telegram 账号登录（会话密钥存在本机钥匙串）', 'high'),
    perm('tg.messages:read', '读取你加入的 Telegram 群和频道里的消息', 'medium'),
  ],
  contributes: { commands: [cmd('tg', '取 Telegram 消息', '从某个 Telegram 群取最近几条消息', [arg('群名', 'Telegram 群或频道'), arg('条数', '默认 10 条', false)])], panels: [], events: [] },
  changelog: [
    { version: '0.9.1', date: '2026-10-08', notes: ['支持频道'] },
    { version: '0.9.0', date: '2026-09-12', notes: ['第一个公开版本'] },
  ],
}
const cve: PluginManifest = {
  id: 'g-group.cve', name: 'CVE 订阅', publisher: OFFICIAL, version: '1.3.0', category: 'source',
  summary: '有新漏洞公告就推给挂了它的助手，由它判断是否命中',
  description: '订阅公开漏洞库。有新公告时叫醒挂了它的助手，由助手对照本群工作区的依赖判断要不要告诉你。严重度、时限这些是插件自己的配置。',
  icon: { letter: 'C', color: '#b45309' },
  permissions: [
    perm('cve.feed', '读取公开漏洞库（NVD、GitHub Advisory）', 'low'),
    perm('repo.deps:read', '读取本群工作区的依赖清单（package.json、lockfile）', 'medium'),
  ],
  contributes: {
    commands: [cmd('cve', '查漏洞', '查某个包有没有已知漏洞', [arg('包名', '比如 lodash')])],
    panels: [],
    events: [{ name: 'cve.published', desc: '有新公告时叫醒挂了它的助手' }],
  },
  changelog: [
    { version: '1.3.0', date: '2026-10-28', notes: ['加了 CVSS 分数，命中判断更准'] },
    { version: '1.2.0', date: '2026-09-02', notes: ['支持 Go 和 Rust 依赖'] },
  ],
}
const pulsePlugin: PluginManifest = {
  id: 'g-group.pulse', name: '动向时间线', publisher: OFFICIAL, version: '0.3.1', category: 'ui',
  summary: '群里每过一段讨论，助手写一段摘要，按时间排成一条线',
  description: '在群资料·插件里展开一条时间线。每段摘要能点回它覆盖的那几条消息。摘要只读，不能替你批准或关闭任何待确认的事。',
  icon: { letter: '线', color: '#0f766e' },
  permissions: [perm('chat.messages:read', '读取本群消息（只在挂了它的群里）', 'medium'), perm('panel.render', '在群资料里加一块「动向时间线」面板', 'low')],
  contributes: {
    commands: [cmd('pulse', '写一段动向', '让助手现在就把最近这段讨论写成一段摘要')],
    panels: [{ id: 'pulse', title: '动向时间线', desc: '群资料·插件页签里展开，点一段回到原消息' }],
    events: [{ name: 'chat.every-n', desc: '本群每过 N 条消息叫醒助手写一段' }],
  },
  changelog: [{ version: '0.3.1', date: '2026-10-15', notes: ['每段摘要能点回原消息'] }],
}
const board: PluginManifest = {
  id: 'g-group.board', name: '看板面板', publisher: OFFICIAL, version: '0.4.0', category: 'ui',
  summary: '在群右侧加一块看板，清单按状态分列',
  description: '把群清单按「待认领 / 进行中 / 已完成」分成三列，拖动卡片就能改状态。',
  icon: { letter: '板', color: '#8b5cf6' },
  permissions: [perm('checklist:read', '读取本群清单', 'low'), perm('checklist:write', '拖动卡片时改清单状态', 'medium')],
  contributes: { commands: [cmd('board', '打开看板', '在右侧打开本群看板')], panels: [{ id: 'board', title: '看板', desc: '右侧面板' }], events: [] },
  changelog: [{ version: '0.4.0', date: '2026-10-20', notes: ['卡片能拖动改状态'] }],
}
const github: PluginManifest = {
  id: 'octolabs.github', name: 'GitHub', publisher: 'Octo Labs', version: '1.2.0', category: 'source',
  summary: '把 issue、PR 和评论带进对话',
  description: '读你授权仓库的 issue、PR 和评论，勾选后带进对话。可选：以你的账号在 PR 下回帖（高风险，默认不开）。',
  icon: { letter: 'GH', color: '#24292f' },
  permissions: [perm('gh.repo:read', '读取你授权仓库的 issue、PR 和评论', 'medium'), perm('gh.comment', '以你的账号在 issue / PR 下发评论', 'high')],
  contributes: { commands: [cmd('gh', '取 issue / PR', '把某个 issue 或 PR 带进对话', [arg('仓库', 'owner/repo'), arg('编号', '不填就列最近 5 个', false)])], panels: [], events: [] },
  changelog: [{ version: '1.2.0', date: '2026-10-30', notes: ['支持 Draft PR'] }],
}
const translate: PluginManifest = {
  id: 'lingo.translate', name: '翻译', publisher: 'Lingo', version: '1.0.0', category: 'command',
  summary: '把选中的消息翻译成别的语言',
  description: '选中几条消息，用 /translate 翻译，结果只给你看，不发到群里。',
  icon: { letter: '译', color: '#2563eb' },
  permissions: [perm('translate.send', '把你选中的消息发给翻译服务（不含其它消息）', 'medium')],
  contributes: { commands: [cmd('translate', '翻译', '把选中的消息翻译成目标语言', [arg('目标语言', '默认英文', false)])], panels: [], events: [] },
  changelog: [{ version: '1.0.0', date: '2026-07-15', notes: ['第一个版本'] }],
}
const jira: PluginManifest = {
  id: 'acme.jira', name: 'Jira', publisher: 'Acme 工具组', version: '0.6.0', category: 'command',
  summary: '查需求单状态，把评论带进对话',
  description: '用 /jira 单号 查一张单子的状态和最近评论。改状态、加评论需要高风险权限。',
  icon: { letter: 'J', color: '#0052cc' },
  permissions: [perm('jira.issues:read', '读取你有权限的 Jira 单', 'medium'), perm('jira.issues:write', '改单子状态、加评论', 'high')],
  contributes: { commands: [cmd('jira', '查 Jira 单', '查一张单子的状态和最近评论', [arg('单号', '比如 APP-123')])], panels: [], events: [] },
  changelog: [{ version: '0.6.0', date: '2026-10-02', notes: ['支持子任务'] }],
}
const web: PluginManifest = {
  id: 'g-group.web', name: '网页抓取', publisher: OFFICIAL, version: '1.1.0', category: 'source',
  summary: '打开一个网页，把正文带进对话',
  description: '抓取一个公开网页的正文，标「不可信外部数据」后挂到引用条。不带你的登录态。',
  icon: { letter: '网', color: '#0891b2' },
  permissions: [perm('net.fetch', '访问公网网页（只读，不带你的登录态）', 'low')],
  contributes: { commands: [cmd('web', '抓网页', '把一个网页的正文带进对话', [arg('网址', 'https 开头')])], panels: [], events: [] },
  changelog: [{ version: '1.1.0', date: '2026-09-25', notes: ['去掉了广告和导航'] }],
}
export const pluginCatalog0: PluginManifest[] = [feishu, gmail, telegram, cve, github, web, pulsePlugin, board, webhook, translate, jira]
/** 本机已装的旧版本：飞书 1.4.2（1.5.0 多要「读取飞书文档」）、CVE 1.2.0（权限没变） */
const feishu142: PluginManifest = { ...feishu, version: '1.4.2', permissions: feishu.permissions.filter((p) => p.scope !== 'feishu.docs:read'), changelog: feishu.changelog.slice(1) }
const cve120: PluginManifest = { ...cve, version: '1.2.0', changelog: cve.changelog.slice(1) }
export const plugins0: PluginState[] = [
  { ...seedInstalled(feishu142, { enabled: true, convs: ['g', 'g-design'], callers: ['argon', 'claude'] }), cred: '已登录 · 只读' },
  { ...seedInstalled(gmail, { enabled: true, convs: ['g'], callers: ['argon'] }), cred: 'OAuth · 7 天后过期',
    grant: { commitment: '每天 18:00 待验收汇总', sender: 'me@team.com', recipients: ['wang@team.com'], sources: ['本群消息'], contentPolicy: 'summary', maxPerHour: 3, pluginVersion: '2.1.0', revoked: false } },
  { ...seedInstalled(webhook, { enabled: true, convs: [], callers: [] }), cred: '还没设地址', grant: null },
  { ...seedInstalled(cve120, { enabled: true, convs: ['g'], callers: ['claude'] }), cred: '公开数据 · 不需要登录' },
  { ...seedInstalled(pulsePlugin, { enabled: true, convs: ['g'], callers: ['argon'] }) },
]

/** 动向时间线插件（#2273 U80）：联系人每过 N 条消息写一段摘要，按时间排。每段指回它覆盖的那几条消息 */
export interface PulseItem { id: string; conv: string; at: string; by: PersonId; text: string; from: string; to: string; n: number }
export const pulse0: PulseItem[] = [
  { id: 'pl1', conv: 'g', at: '昨天 21:30', by: 'argon', text: '定下群聊先只做文字消息，Compute 结果以消息形式回群', from: 'g1', to: 'g2', n: 30 },
  { id: 'pl2', conv: 'g', at: '昨天 23:50', by: 'argon', text: '登录页深色交给 Claude Code，Astra 复核，有进度在群里 @你', from: 'g2', to: 'g9', n: 30 },
  { id: 'pl3', conv: 'g', at: '今天 00:40', by: 'argon', text: '首页性能交给 Codex，目标首屏 1.5 秒内', from: 'g9', to: 'g10', n: 30 },
  { id: 'pl4', conv: 'g', at: '今天 01:10', by: 'argon', text: '飞书接入方案收敛到「勾选引用」，不做全量同步', from: 'g10', to: 'g12', n: 30 },
]


/** U09：群临时算力现在借出去几格。只算借自本群池子、还没结束的 */
export const poolUsed = (cs: Record<string, Compute>, conv: string) =>
  Object.values(cs).filter((c) => c.conv === conv && c.pool === 'group' && (c.status === 'running' || c.status === 'waiting' || c.stopping)).length
