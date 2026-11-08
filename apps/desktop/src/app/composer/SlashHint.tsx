import type { SlashInvocation } from '@g-group/ui-core'
import { cn } from '@/lib/utils'
import { SourceBadge } from './SourceBadge'

/** 命令提示:是哪条命令、现在该填什么、哪里不对 */
export function SlashHint({ inv }: { inv: SlashInvocation }) {
  const shownErr = inv.args.filter((a, i) => a.error && !(inv.typing && i === inv.current)).map((a) => a.error!)
  const cur = inv.current >= 0 ? inv.args[inv.current]!.arg : undefined
  return (
    <div data-testid="slash-hint" className="flex min-w-0 items-center gap-2 px-3 pt-2 text-[12px]">
      <SourceBadge src={inv.command.source} />
      <span className="shrink-0 font-mono text-fg">/{inv.command.name}</span>
      <span className="shrink-0 text-fg-2">{inv.command.title}</span>
      <span className="text-fg-3">·</span>
      {inv.blocked ? <span className="min-w-0 truncate text-err">{inv.blocked}</span>
        : shownErr.length ? <span data-testid="slash-error" className="min-w-0 truncate text-err">{shownErr[0]}</span>
        : inv.ok && !(cur && inv.args[inv.current]?.value === undefined) ? <span className="min-w-0 truncate text-fg-3">回车执行 · {inv.command.desc}</span>
        : cur ? <span className="min-w-0 truncate text-fg-3"><span className="font-medium text-fg-2">{cur.name}</span>{cur.required ? '' : '（可选）'}：{cur.hint}</span>
        : null}
    </div>
  )
}

/** 打了个不存在的命令:说清楚回车会当普通消息发 */
export function SlashUnknown({ name }: { name: string }) {
  return <div data-testid="slash-unknown" className="px-3 pt-2 text-[12px] text-fg-3">没有 <span className="font-mono text-fg-2">/{name}</span> 这个命令，回车会当普通消息发出</div>
}

/** 参数提示:在你打的字后面接上还没填的参数(当前该填的高亮,后面的灰色)。和输入框同字号同行高,叠在它下面 */
export function ArgGhost({ inv, draft }: { inv: SlashInvocation; draft: string }) {
  return (
    <div aria-hidden data-testid="slash-ghost" className="pointer-events-none absolute inset-x-3 top-0 whitespace-pre-wrap break-words py-2 text-[14.5px] leading-[1.6]">
      <span className="invisible">{draft}</span>
      {/\s$/.test(draft) ? '' : ' '}
      {inv.args.map((a, i) => a.value === undefined && (
        <span key={a.arg.name}>
          <span data-testid={`slash-arg-${a.arg.name}`} data-current={i === inv.current && !inv.typing ? '1' : undefined} className={cn('rounded-[5px] px-1 py-px', i === inv.current && !inv.typing ? 'bg-me/10 text-me' : 'text-fg-3')}>{a.arg.required ? a.arg.name : `${a.arg.name}（可选）`}</span>{' '}
        </span>
      ))}
    </div>
  )
}
