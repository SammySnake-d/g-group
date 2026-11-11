import { useLayoutEffect, useRef, useState } from 'react'
import { ArrowLeft, CornerUpLeft, X } from 'lucide-react'
import { Button } from '@astryxdesign/core/Button'
import { Card } from '@astryxdesign/core/Card'
import { cn } from '@/lib/utils'
import type { Artifact } from '@/data'
import { useApp } from '@/store'
import { FileBody } from './FileBody'
import { ProvenanceRail, ProvenanceThread } from './Provenance'
import { discussFile } from './context'

/* 阅读区 = 正文 + 右侧来处。来处随阅读位置固定(sticky),长文档翻到哪里都在旁边;
   窗口变窄时先收窄来处、正文让位,再窄收成一列头像,不把来处塞进会被卷走的正文里。 */
const tier = (w: number) => (w >= 900 ? { aside: 236, gap: 32, pad: 32, rail: false } : w >= 600 ? { aside: 196, gap: 20, pad: 16, rail: false } : { aside: 40, gap: 12, pad: 12, rail: true })

function useBox<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const [box, setBox] = useState({ w: 0, h: 0 })
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    setBox({ w: el.clientWidth, h: el.clientHeight })
    const ro = new ResizeObserver(([e]) => setBox({ w: e.contentRect.width, h: e.contentRect.height }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, box] as const
}

export function FileReader({ artifact: a, onBack, compact = false }: { artifact: Artifact; onBack: () => void; compact?: boolean }) {
  const hasConv = useApp((s) => s.convs.some((c) => c.id === a.conv))
  const [ref, box] = useBox<HTMLElement>()
  const t = tier(box.w)
  return <div data-testid="files-main" data-file={a.id} data-prototype="file-reader" className="relative flex min-h-0 min-w-0 flex-1 flex-col bg-side/40">
    <header className="flex h-[52px] shrink-0 items-center gap-1 border-b border-line pl-3 pr-3">
      <Button label={compact ? '关闭预览' : '全部文件'} isIconOnly variant="ghost" size="sm" icon={compact ? <X /> : <ArrowLeft />} onClick={onBack} />
      <div className="flex-1" />
      <Button label="接着聊" icon={<CornerUpLeft />} variant="primary" size="sm" onClick={() => discussFile(a)} isDisabled={!hasConv} data-testid="file-discuss" className="shrink-0" />
    </header>
    <main ref={ref} data-testid="file-scroll" className="scroll-thin min-h-0 min-w-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-[1000px] items-start" style={{ gap: t.gap, padding: `${t.pad}px ${t.pad}px` }}>
        <Card padding={0} className={cn('min-w-0 flex-1 rounded-lg border border-line bg-elev shadow-soft', box.w >= 900 ? 'px-12 pb-14 pt-10' : 'px-6 pb-10 pt-7')}>
          <div className="mb-6 flex items-start justify-between gap-4"><h1 className="min-w-0 break-words text-[25px] font-semibold leading-snug tracking-tight [overflow-wrap:anywhere]">{a.name}</h1><span className="shrink-0 pt-1 text-[13px] text-fg-2">{a.meta}</span></div>
          <div data-testid="file-preview"><FileBody artifact={a} /></div>
        </Card>
        <aside data-testid="file-aside" className="scroll-thin sticky shrink-0 overflow-y-auto overscroll-contain" style={{ width: t.aside, top: t.pad, maxHeight: box.h ? box.h - t.pad * 2 : undefined }}>
          {t.rail ? <ProvenanceRail artifact={a} /> : <ProvenanceThread artifact={a} />}
        </aside>
      </div>
    </main>
  </div>
}
