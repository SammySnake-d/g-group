import { Fragment } from 'react'
import { cn } from '@/lib/utils'

/* harness 说的话：只认三样——空行分段、「- 」开头的列表、反引号里的代码。够读，不引一整个 markdown 引擎。
   正文 13.5px、行高 1.7、每行不超过 68 个字宽（impeccable：正文 65–75ch）。 */

function Inline({ text }: { text: string }) {
  const parts = text.split('`')
  return (
    <>
      {parts.map((p, i) =>
        i % 2 === 1 ? <code key={i} className="rounded bg-hover px-1 py-px font-code text-[0.92em] text-fg">{p}</code> : <Fragment key={i}>{p}</Fragment>,
      )}
    </>
  )
}

type Para = { kind: 'p'; lines: string[] } | { kind: 'ul'; items: string[] }

function parse(text: string): Para[] {
  const out: Para[] = []
  for (const chunk of text.trim().split(/\n\s*\n/)) {
    const lines = chunk.split('\n')
    if (lines.every((l) => /^\s*[-•]\s+/.test(l))) out.push({ kind: 'ul', items: lines.map((l) => l.replace(/^\s*[-•]\s+/, '')) })
    else out.push({ kind: 'p', lines })
  }
  return out
}

export function Prose({ text, className, size = 'md' }: { text: string; className?: string; size?: 'sm' | 'md' }) {
  return (
    <div className={cn('max-w-[68ch] space-y-2 text-fg', size === 'md' ? 'text-[13.5px] leading-[1.7]' : 'text-[12px] leading-relaxed text-fg-2', className)}>
      {parse(text).map((p, i) =>
        p.kind === 'ul' ? (
          <ul key={i} className="list-disc space-y-0.5 pl-5 marker:text-fg-3">
            {p.items.map((it, j) => <li key={j}><Inline text={it} /></li>)}
          </ul>
        ) : (
          <p key={i}>
            {p.lines.map((l, j) => <Fragment key={j}>{j > 0 && <br />}<Inline text={l} /></Fragment>)}
          </p>
        ),
      )}
    </div>
  )
}
