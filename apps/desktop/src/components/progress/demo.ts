import type { ReasonClass, SubKind, Threshold, UnitState } from '@g-group/ui-core'

/*
  进展全景的补充演示数据。会话、联系人、Compute 先用 data.ts 里现有的(adapter.ts 映射);
  看板要的台账字段(上游、轮数、原因类别、阈值、问在哪条消息,D26 §3)和 data.ts 没有的东西——
  子代理 / 子对话 / 后台任务、同一人多个 Compute、各种状态(排队、失败三种原因、已停止、两条同因失败合成群级提示、超过 6 个要折叠的子任务)——
  在这里按 compute id 关联补上。时间写成「距演示时钟几分钟前」,演示时钟对齐 data.ts 里聊天的 02:16。
*/

/** 演示时钟:data.ts 的聊天停在 02:1x,看板的「现在」取当天 02:16 */
export const DEMO_CLOCK = { h: 2, m: 16 } as const

/** data.ts 里已有 Compute 缺的台账字段。askPending:这条待你处理还在,就算「等你处理」,问题和落点取自它 */
export interface Ledger { upstream: string; turns: number; reason?: ReasonClass; threshold?: Threshold; askPending?: string }
export const LEDGER: Record<string, Ledger> = {
  login: { upstream: 'Anthropic 官方', turns: 6 },
  keys: { upstream: 'Anthropic 官方', turns: 2 },
  perf: { upstream: 'OpenAI 官方', turns: 5 },
  scrape: { upstream: 'xAI 官方', turns: 3, reason: 'unknown' },
  logs: { upstream: 'OpenAI 官方', turns: 2 },
  feishu: { upstream: 'Google 官方', turns: 4, askPending: 'q-stall' },
  research: { upstream: 'OpenAI 官方', turns: 6 },
  review: { upstream: 'Anthropic 官方', turns: 5 },
  search: { upstream: 'Anthropic 官方', turns: 2 },
  weather: { upstream: 'xAI 官方', turns: 1 },
}

/** 补充的 Compute。started / last / ended 是距演示时钟的分钟数;askPending 同上,待你处理答完后回到 state */
export interface DemoCompute {
  id: string; conv: string; owner: string; title: string; model: string; upstream: string; state: UnitState
  reason?: ReasonClass; reasonRaw?: string; started: number; last?: number; ended?: number; turns: number; seq: number
  askPending?: string; queuedBehind?: string; threshold?: Threshold
}
const D = (c: Omit<DemoCompute, 'model' | 'upstream'> & Partial<DemoCompute>): DemoCompute => ({ model: 'Claude Opus 5.5', upstream: 'Anthropic 官方', ...c })

export const DEMO_COMPUTES: DemoCompute[] = [
  // 模型助手群聊:Codex 两条同上游同原因失败 → 群级提示;Astra 按单独设的阈值判卡住;Argon 一条等你、一条你停的
  D({ id: 'd-ledger', conv: 'g', owner: 'codex', title: '承诺账本最小闭环', model: 'GPT-6.1', upstream: 'OpenAI 中转 A', state: 'failed', reason: 'upstream_unavailable', reasonRaw: '503 Service Unavailable · upstream connect error or disconnect/reset before headers. reset reason: overflow', started: 74, last: 62, ended: 62, turns: 5, seq: 1262, threshold: { minutes: 15, custom: false } }),
  D({ id: 'd-pr8', conv: 'g', owner: 'codex', title: 'PR #8 第五轮返修', model: 'GPT-6.1', upstream: 'OpenAI 中转 A', state: 'failed', reason: 'upstream_unavailable', reasonRaw: '502 Bad Gateway · no upstream available for model gpt-6.1', started: 56, last: 52, ended: 52, turns: 2, seq: 1270, threshold: { minutes: 15, custom: false } }),
  D({ id: 'd-review7', conv: 'g', owner: 'astra', title: '复审 PR #7 第八轮', model: 'GPT-6', upstream: 'OpenAI 官方', state: 'failed', reason: 'stalled', reasonRaw: '这一轮 20 分钟没有任何事件（模型调用已收到首字节，之后再无输出）；已按停止流程收掉。', started: 106, last: 88, ended: 68, turns: 7, seq: 1240, threshold: { minutes: 20, custom: true, by: 'Astra' } }),
  D({ id: 'd-sync', conv: 'g', owner: 'argon', title: '飞书聊天记录怎么带进对话', model: 'Gemini 4', upstream: 'Google 官方', state: 'running', started: 18, last: 4, turns: 3, seq: 1291, askPending: 'q1' }),
  D({ id: 'd-perm', conv: 'g', owner: 'argon', title: '飞书权限方案对比', model: 'Gemini 4', upstream: 'Google 官方', state: 'interrupted', reason: 'user_stopped', started: 144, last: 140, ended: 140, turns: 2, seq: 1236 }),
  // 前端设计讨论
  D({ id: 'd-digest', conv: 'g-design', owner: 'grok', title: '总结 8 篇设计文章', model: 'Grok 5', upstream: 'xAI 官方', state: 'failed', reason: 'context_overflow', reasonRaw: 'Prompt is too long · automatic compaction failed: no assistant message in summarization response', started: 366, last: 335, ended: 335, turns: 11, seq: 412 }),
  D({ id: 'd-v2', conv: 'g-design', owner: 'claude', title: '设计稿 v2 和 GrokBot 逐屏对比', state: 'done', started: 431, last: 398, ended: 398, turns: 8, seq: 405 }),
  D({ id: 'd-palette', conv: 'g-design', owner: 'argon', title: '整理配色参考链接', model: 'Gemini 4', upstream: 'Google 官方', state: 'done', started: 1994, last: 1976, ended: 1976, turns: 2, seq: 377 }),
  // 私聊:Claude Code 一条带 12 个子任务的返修(子任务超过 6 个折叠);Codex 两条在跑、一条排队
  D({ id: 'd-pr1', conv: 'dm-claude', owner: 'claude', title: 'PR #1 第十一轮返修', state: 'running', started: 140, last: 1, turns: 14, seq: 87 }),
  D({ id: 'd-manual', conv: 'dm-claude', owner: 'claude', title: '整理开发手册原则 69', state: 'done', started: 2036, last: 2011, ended: 2011, turns: 5, seq: 71 }),
  D({ id: 'd-mut', conv: 'dm-codex', owner: 'codex', title: 'PR #7 跑 112 个变异', model: 'GPT-6.1', upstream: 'OpenAI 官方', state: 'running', started: 58, last: 2, turns: 3, seq: 61 }),
  D({ id: 'd-pr4', conv: 'dm-codex', owner: 'codex', title: 'PR #4 第二十一轮返修', model: 'GPT-6.1', upstream: 'OpenAI 官方', state: 'queued', started: 13, last: 13, turns: 0, seq: 63, queuedBehind: 'Codex 同时最多跑 2 个，等前一个跑完' }),
  D({ id: 'd-recheck', conv: 'dm-astra', owner: 'astra', title: '复核报告整理成一页', model: 'GPT-6', upstream: 'OpenAI 官方', state: 'done', started: 680, last: 651, ended: 651, turns: 4, seq: 33 }),
  D({ id: 'd-tz', conv: 'dm-gemini', owner: 'gemini', title: '时区换算：东京下午 3 点是北京几点', model: 'Gemini Flash', upstream: 'Google 官方', state: 'done', started: 3500, last: 3499, ended: 3499, turns: 1, seq: 12 }),
]

/** 子代理 / 子对话 / 后台任务,parent 是 Compute id(data.ts 里的或上面补的) */
export interface DemoSub { id: string; parent: string; kind: SubKind; title: string; state: UnitState; reason?: ReasonClass; reasonRaw?: string; started: number; last?: number; ended?: number }
const S = (s: DemoSub) => s

export const DEMO_SUBS: DemoSub[] = [
  S({ id: 'sl1', parent: 'login', kind: 'job', title: 'pnpm test login', state: 'running', started: 1, last: 0 }),
  S({ id: 'sl2', parent: 'login', kind: 'subagent', title: '核对配色 token', state: 'done', started: 4, ended: 3 }),
  S({ id: 'sl3', parent: 'login', kind: 'subchat', title: '问 Astra 复核口径', state: 'done', started: 3, ended: 2 }),
  S({ id: 'sk1', parent: 'keys', kind: 'subagent', title: '列出现有快捷键', state: 'done', started: 3, ended: 2 }),
  S({ id: 'sp1', parent: 'perf', kind: 'job', title: 'lighthouse 首屏（改前）', state: 'done', started: 45, ended: 44 }),
  S({ id: 'sp2', parent: 'perf', kind: 'job', title: 'lighthouse 首屏（改后）', state: 'done', started: 36, ended: 35 }),
  S({ id: 'sp3', parent: 'perf', kind: 'subchat', title: '请 Astra 换模型复核', state: 'done', started: 32, ended: 30 }),
  S({ id: 'ss1', parent: 'scrape', kind: 'job', title: 'GET x.ai/news/designing-grok-bot', state: 'failed', reasonRaw: '503 Service Unavailable（第 3 次）', started: 14, ended: 13 }),
  S({ id: 'sg1', parent: 'logs', kind: 'job', title: '打开 ops.team.com', state: 'running', started: 6, last: 1 }),
  S({ id: 'sf1', parent: 'feishu', kind: 'job', title: 'GET /open-apis/application/v6/scopes', state: 'running', started: 18, last: 14 }),
  S({ id: 'sd1', parent: 'd-ledger', kind: 'job', title: 'node --test ledger', state: 'orphaned', reasonRaw: 'Compute 判失败时它还在跑，已一并收掉', started: 65, ended: 62 }),
  S({ id: 'sd2', parent: 'd-digest', kind: 'subagent', title: '抽取配色与字号', state: 'done', started: 361, ended: 350 }),
  S({ id: 'sd3', parent: 'd-digest', kind: 'subagent', title: '先总结前 4 篇', state: 'done', started: 364, ended: 346 }),
  S({ id: 'sm1', parent: 'd-mut', kind: 'job', title: 'mutation run · 并发 2', state: 'running', started: 58, last: 2 }),
  // d-pr1:12 个子任务,超过 6 个折叠成「还有 N 个」
  S({ id: 'sr1', parent: 'd-pr1', kind: 'subagent', title: '复现 R10-03 并写失败用例', state: 'running', started: 35, last: 2 }),
  S({ id: 'sr2', parent: 'd-pr1', kind: 'job', title: 'run-all --hash', state: 'running', started: 5, last: 1 }),
  S({ id: 'sr3', parent: 'd-pr1', kind: 'job', title: '变异测试 105 个', state: 'running', started: 40, last: 1 }),
  S({ id: 'sr4', parent: 'd-pr1', kind: 'job', title: '清理临时克隆', state: 'failed', reason: 'unknown', reasonRaw: 'rm: /tmp/gg-pr1-r11: Directory not empty（exit 1）', started: 23, ended: 22 }),
  S({ id: 'sr5', parent: 'd-pr1', kind: 'subagent', title: '核对门禁脚本', state: 'done', started: 59, ended: 48 }),
  S({ id: 'sr6', parent: 'd-pr1', kind: 'job', title: 'Node 22 全量自检', state: 'done', started: 46, ended: 41 }),
  S({ id: 'sr7', parent: 'd-pr1', kind: 'job', title: 'Node 25 全量自检', state: 'done', started: 46, ended: 40 }),
  S({ id: 'sr8', parent: 'd-pr1', kind: 'subchat', title: '问 Codex 审查口径', state: 'done', started: 55, ended: 51 }),
  S({ id: 'sr9', parent: 'd-pr1', kind: 'job', title: 'git push chore/gates', state: 'done', started: 30, ended: 29 }),
  S({ id: 'sr10', parent: 'd-pr1', kind: 'job', title: '回读远端 HEAD', state: 'done', started: 29, ended: 29 }),
  S({ id: 'sr11', parent: 'd-pr1', kind: 'subagent', title: '找 G-PROVENANCE 判定代码', state: 'done', started: 62, ended: 57 }),
  S({ id: 'sr12', parent: 'd-pr1', kind: 'job', title: '截图收据', state: 'done', started: 27, ended: 26 }),
]
