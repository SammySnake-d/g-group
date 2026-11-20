import type { HarnessTranscript } from '@g-group/ui-core'
import { codeSessions } from './demo/code-sessions'
import { codexSessions } from './demo/codex-sessions'
import { webSessions } from './demo/web-sessions'

export { DEMO_NOW } from './demo/build'

export const demoSessions: Record<string, HarnessTranscript> = { ...codeSessions, ...webSessions, ...codexSessions }

export const demoSession = (computeId: string): HarnessTranscript | null => demoSessions[computeId] ?? null
