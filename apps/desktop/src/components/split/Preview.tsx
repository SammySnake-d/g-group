import { MousePointer2 } from 'lucide-react'
import { cn } from '@/lib/utils'

export function Preview({ kind, small = false }: { kind: 'login' | 'home'; small?: boolean }) {
  return (
    <div className={cn('overflow-hidden rounded-xl border border-line bg-elev', !small && 'shadow-elev')}>
      <div className="flex items-center gap-1.5 border-b border-line px-3 py-2">
        <span className="h-2.5 w-2.5 rounded-full bg-fg-3/30" /><span className="h-2.5 w-2.5 rounded-full bg-fg-3/30" /><span className="h-2.5 w-2.5 rounded-full bg-fg-3/30" />
        <span className="ml-2 min-w-0 flex-1 truncate rounded-md bg-hover px-2 py-0.5 text-[11px] text-fg-2">localhost:5173/{kind}</span>
      </div>
      {kind === 'login' ? (
        <div className="relative grid aspect-[16/10] place-items-center bg-zinc-900">
          <div className="w-[46%] space-y-2.5 rounded-xl bg-zinc-800 p-5">
            <div className="mx-auto mb-3 h-2.5 w-16 rounded bg-white/70" />
            <div className="h-7 rounded-md bg-white/10" />
            <div className="h-7 rounded-md bg-white/10 ring-1 ring-white/50" />
            <div className="flex items-center gap-1.5"><span className="h-3 w-3 rounded-sm bg-white/70" /><span className="h-1.5 w-12 rounded bg-white/30" /></div>
            <div className="h-7 rounded-md bg-white/85" />
          </div>
          <MousePointer2 aria-hidden className="absolute left-[54%] top-[56%] h-5 w-5 fill-white text-black drop-shadow" />
        </div>
      ) : (
        <div className="grid aspect-[16/10] grid-cols-[30%_1fr] gap-2 bg-zinc-100 p-3">
          <div className="space-y-2">{[0, 1, 2, 3, 4].map((i) => <div key={i} className="h-6 rounded bg-black/[0.06]" />)}</div>
          <div className="space-y-2 rounded bg-white p-3">{[70, 50, 80, 40, 60].map((w, i) => <div key={i} className="h-3 rounded bg-black/[0.07]" style={{ width: w + '%' }} />)}</div>
        </div>
      )}
    </div>
  )
}
