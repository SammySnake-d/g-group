import type { AgentEvent, BackgroundJob, DeliverableEvent, FileChange, HarnessId, HarnessTranscript, NoticeEvent, ToolEvent, ToolStatus, TranscriptEvent } from '@g-group/ui-core'

/* 演示会话的写法：按时间顺序写「派活、说话、调用、子代理、提示、交付」，时间和序号自动往后走。
   只给演示用；以后换成后端按 computeId 分页取原始事件，类型不变。 */

/** 演示里的「现在」：在跑的会话用时算到这一刻（和 data.ts 里各 Compute 的 elapsed 对得上） */
export const DEMO_NOW = Date.parse('2026-11-09T02:16:00+08:00')

const iso = (day: string, hms: string) => `${day}T${hms}+08:00`

export const ch = (path: string, added: number, removed = 0): FileChange => ({ path, added, removed })

interface ToolOpts { input?: string; output?: string; status?: ToolStatus; ms?: number; changes?: FileChange[]; retryOf?: string }
interface AgentOpts { status: AgentEvent['status']; calls: number; ms: number; result?: string; trail?: (s: Script) => void }

export class Script {
  readonly events: TranscriptEvent[] = []
  private readonly prefix: string
  private clock: number
  private seq = 0
  constructor(prefix: string, clock: number) {
    this.prefix = prefix
    this.clock = clock
  }

  private base() {
    this.seq += 1
    return { id: `${this.prefix}-${this.seq}`, seq: this.seq, at: new Date(this.clock).toISOString() }
  }

  /** 时间往后走 sec 秒 */
  wait(sec: number) {
    this.clock += sec * 1000
    return this
  }

  prompt(from: string, text: string) {
    this.events.push({ ...this.base(), kind: 'prompt', from, text })
    return this.wait(2)
  }

  say(text: string) {
    this.events.push({ ...this.base(), kind: 'text', text })
    return this.wait(4)
  }

  /** 返回这次调用的 id，重试时用作 retryOf */
  tool(name: string, summary: string, o: ToolOpts = {}): string {
    const b = this.base()
    const status = o.status ?? 'ok'
    const e: ToolEvent = { ...b, kind: 'tool', name, summary, status, ...(o.input ? { input: o.input } : {}), ...(o.output ? { output: o.output } : {}), ...(o.changes ? { changes: o.changes } : {}), ...(o.retryOf ? { retryOf: o.retryOf } : {}), ...(status !== 'running' ? { durationMs: o.ms ?? 400 } : {}) }
    this.events.push(e)
    this.wait(Math.ceil((o.ms ?? 400) / 1000))
    return b.id
  }

  agent(label: string, brief: string, o: AgentOpts) {
    const b = this.base()
    let trail: ToolEvent[] | undefined
    if (o.trail) {
      const sub = new Script(`${b.id}-sub`, this.clock)
      o.trail(sub)
      trail = sub.events.filter((e): e is ToolEvent => e.kind === 'tool')
    }
    const e: AgentEvent = { ...b, kind: 'agent', label, brief, status: o.status, calls: o.calls, durationMs: o.ms, ...(o.result ? { result: o.result } : {}), ...(trail ? { trail } : {}) }
    this.events.push(e)
    return this
  }

  notice(level: NoticeEvent['level'], text: string) {
    this.events.push({ ...this.base(), kind: 'notice', level, text })
    return this
  }

  deliver(name: string, type: DeliverableEvent['type'], ref: string, size?: string) {
    this.events.push({ ...this.base(), kind: 'deliverable', name, type, ref, ...(size ? { size } : {}) })
    return this
  }
}

interface SessionSpec {
  computeId: string
  harness: HarnessId
  model: string
  day?: string
  start: string
  end?: string
  turns?: number
  background?: BackgroundJob[]
  nativeSessionId?: string
}

export function session(spec: SessionSpec, write: (s: Script) => void): HarnessTranscript {
  const day = spec.day ?? '2026-11-09'
  const s = new Script(spec.computeId, Date.parse(iso(day, spec.start)))
  write(s)
  return {
    meta: {
      computeId: spec.computeId,
      harness: spec.harness,
      model: spec.model,
      nativeSessionId: spec.nativeSessionId ?? null,
      startedAt: iso(day, spec.start),
      endedAt: spec.end ? iso(day, spec.end) : null,
      turns: spec.turns ?? 1,
      background: spec.background ?? [],
    },
    events: s.events,
    hasEarlier: false,
  }
}
