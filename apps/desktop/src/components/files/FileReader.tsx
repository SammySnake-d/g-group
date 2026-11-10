import { ArrowLeft, CornerUpLeft, X } from 'lucide-react'
import { Button } from '@astryxdesign/core/Button'
import { Card } from '@astryxdesign/core/Card'
import type { Artifact } from '@/data'
import { useApp } from '@/store'
import { FileBody } from './FileBody'
import { Provenance } from './Provenance'
import { discussFile } from './context'

// 来处只占页头一行,正文独占阅读区;页头高度与聊天页头一致。
export function FileReader({ artifact: a, onBack, compact = false }: { artifact: Artifact; onBack: () => void; compact?: boolean }) {
  const hasConv = useApp((s) => s.convs.some((c) => c.id === a.conv))
  return <div data-testid="files-main" data-file={a.id} data-prototype="file-reader" className="relative flex min-h-0 min-w-0 flex-1 flex-col bg-side/40">
    <header className="flex h-[52px] shrink-0 items-center gap-1 border-b border-line pl-3 pr-3">
      <Button label={compact ? '关闭预览' : '全部文件'} isIconOnly variant="ghost" size="sm" icon={compact ? <X /> : <ArrowLeft />} onClick={onBack} />
      <Provenance artifact={a} />
      <Button label="接着聊" icon={<CornerUpLeft />} variant="primary" size="sm" onClick={() => discussFile(a)} isDisabled={!hasConv} data-testid="file-discuss" className="shrink-0" />
    </header>
    <main className="scroll-thin min-h-0 min-w-0 flex-1 overflow-y-auto">
      <Card padding={0} className="mx-auto my-8 max-w-[780px] rounded-lg border border-line bg-elev px-12 pb-14 pt-10 shadow-soft max-[1150px]:mx-6 max-[1150px]:my-6 max-[1150px]:p-8 max-[900px]:mx-4 max-[900px]:p-6">
        <div className="mb-8 flex items-start justify-between gap-4"><h1 className="min-w-0 break-words text-[25px] font-semibold leading-snug tracking-tight [overflow-wrap:anywhere]">{a.name}</h1><span className="shrink-0 pt-1 text-[13px] text-fg-2">{a.meta}</span></div>
        <div data-testid="file-preview"><FileBody artifact={a} /></div>
      </Card>
    </main>
  </div>
}
