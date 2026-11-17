import type { HarnessTranscript } from '@g-group/ui-core'
import { codeSessions } from './demo/code-sessions'
import { codexSessions } from './demo/codex-sessions'
import { webSessions } from './demo/web-sessions'

/* 演示用的 harness 原始会话，按 data.ts 里 computes0 的 id 一一对应。
   后端合同现在没有原始记录（只有 tasks.progress 的语义进度）；接上以后换成按 computeId 分页取，界面不用改。 */
export { DEMO_NOW } from './demo/build'

export const demoSessions: Record<string, HarnessTranscript> = { ...codeSessions, ...webSessions, ...codexSessions }

export const demoSession = (computeId: string): HarnessTranscript | null => demoSessions[computeId] ?? null
