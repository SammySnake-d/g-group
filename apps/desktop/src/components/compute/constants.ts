import { File, Globe, Search, SquarePen, Terminal, Wrench, type LucideIcon } from 'lucide-react'
import type { HarnessId, ToolKind, ToolTally, WorkSummary } from '@g-group/ui-core'
import type { CStatus } from '@/data'

/* Compute 卡片与 harness 会话窗口的文案、状态映射与图标。组件里不写死这些。
   用词照 mirasim 会话窗口的中文串（hub.callsN「N 个调用」、hub.act.agents「N 个子代理」、hub.turnDeliverables「本轮交付」…）。 */

export const HARNESS_LABEL: Record<HarnessId, string> = { 'claude-code': 'Claude Code', codex: 'Codex' }

export type Tone = 'neutral' | 'run' | 'warm' | 'err' | 'ok'

export const STATUS: Record<CStatus, { label: string; tone: Tone }> = {
  running: { label: '进行中', tone: 'run' },
  waiting: { label: '等你回复', tone: 'warm' },
  error: { label: '出错了', tone: 'err' },
  done: { label: '已完成', tone: 'ok' },
  stopped: { label: '已停止', tone: 'neutral' },
}

/** 工具类别的图标：mirasim 的 shell / file / search / web / tool 五种画法，对应到 lucide 的同形图标 */
export const TOOL_ICON: Record<ToolKind, LucideIcon> = { edit: SquarePen, command: Terminal, read: File, search: Search, web: Globe, other: Wrench }

const KIND_WORD: Record<ToolKind, string> = { edit: '改', command: '命令', read: '读', search: '搜', web: '网页', other: '其它' }
const KIND_ORDER: ToolKind[] = ['edit', 'command', 'read', 'search', 'web', 'other']

export const COPY = {
  compute: 'Compute',
  openSession: '打开会话',
  sessionTag: '会话',
  back: '返回',
  close: '关闭',
  source: '来源',
  dispatched: (owner: string) => `${owner} 派的活`,
  step: (now: number, total: number) => `第 ${now}/${total} 步`,
  stoppedAt: (now: number, total: number) => `停在第 ${now}/${total} 步`,
  stepFailed: (step: string) => `${step}失败`,
  turns: (n: number) => `${n} 轮`,
  calls: (n: number) => `${n} 个调用`,
  failedCalls: (n: number, recovered: number) => (recovered >= n ? `${n} 次失败 · 已重试` : `${n} 次失败`),
  attempt: (n: number) => `第 ${n} 次`,
  failed: '失败',
  agents: (n: number) => `${n} 个子代理`,
  agentsRunning: (n: number) => `${n} 个进行中`,
  agentsBack: (n: number) => `${n} 个已回来`,
  agentsFailed: (n: number) => `失败 ${n}`,
  agentRunning: '后台运行中',
  agentFailed: '已失败',
  brief: '任务',
  trail: '过程',
  result: '结果',
  input: '输入',
  command: '命令',
  output: '输出',
  noDetail: '无记录明细',
  deliverables: '本轮交付',
  changes: '改动文件',
  background: '后台任务',
  backgroundN: (n: number) => `后台 ${n} 个任务`,
  steps: '步骤',
  stalled: (min: number) => `${min} 分钟没动静`,
  stuckAt: (step: string) => `卡在「${step}」`,
  needsHuman: '要你来',
  stopping: '正在停止',
  retry: '重试',
  switchModel: '换个模型',
  skip: '跳过',
  readonly: (owner: string) => `Compute 只读，要改要求去找 ${owner} 说`,
  talk: (dm: boolean, owner: string) => `回${dm ? '私聊' : '群里'} @${owner}`,
  noTranscript: '还没拿到这个 Compute 的 harness 记录',
  noTranscriptHint: '后端接上原始会话后，这里会显示它和 harness 的完整对话。',
  earlier: '更早的记录还没加载',
} as const

export const JOB_STATE: Record<'running' | 'done' | 'failed' | 'killed', { label: string; tone: Tone }> = {
  running: { label: '运行中', tone: 'run' },
  done: { label: '已结束', tone: 'neutral' },
  failed: { label: '失败', tone: 'err' },
  killed: { label: '已收掉', tone: 'neutral' },
}

/** 折叠的工具组上那串「改 2 · 命令 1 · 读 3」 */
export function toolMix(t: ToolTally): string {
  return KIND_ORDER.filter((k) => t[k] > 0).map((k) => `${KIND_WORD[k]} ${t[k]}`).join(' · ')
}

/** mirasim 消息头那句「改了 1 个文件，执行了 37 条命令」(hub.act.*)：按 改 → 命令 → 读 → 搜 → 网页 取前两样 */
export function workLine(s: WorkSummary): string {
  const parts = [
    s.filesChanged > 0 ? `改了 ${s.filesChanged} 个文件` : '',
    s.byKind.command > 0 ? `执行了 ${s.byKind.command} 条命令` : '',
    s.byKind.read > 0 ? `读了 ${s.byKind.read} 个文件` : '',
    s.byKind.search > 0 ? `搜索了 ${s.byKind.search} 次` : '',
    s.byKind.web > 0 ? `查了 ${s.byKind.web} 次网页` : '',
  ].filter(Boolean)
  if (parts.length) return parts.slice(0, 2).join('，')
  return s.calls > 0 ? `用了 ${s.calls} 次工具` : '还没动手'
}
