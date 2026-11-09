import { ArrowLeft, ArrowUpRight, CornerUpLeft, MessageSquare, X } from 'lucide-react'
import { Button } from '@astryxdesign/core/Button'
import { ToggleButton } from '@astryxdesign/core/ToggleButton'
import { Card } from '@astryxdesign/core/Card'
import { ClickableCard } from '@astryxdesign/core/ClickableCard'
import { useState } from 'react'
import { people, type Artifact } from '@/data'
import { useApp } from '@/store'
import { Avatar } from '../Avatar'
import { FileBody } from './FileBody'
import { discussFile, fileContext, messageText, sourceLabel } from './context'

export function FileReader({ artifact: a, onBack, compact = false }: { artifact: Artifact; onBack: () => void; compact?: boolean }) {
  const { convs, jump, openConv } = useApp()
  const [contextOpen, setContextOpen] = useState(false)
  const { conv, source, related } = fileContext(a, convs)
  const label = sourceLabel(conv)
  return <div data-testid="files-main" data-file={a.id} data-prototype="file-reader" className="relative flex min-h-0 min-w-0 flex-1 flex-col bg-side/40">
    <header className="flex min-h-[72px] flex-wrap items-center gap-3 border-b border-line px-6 py-3 max-[900px]:gap-2 max-[900px]:px-3">
      <Button label={compact ? '关闭预览' : '全部文件'} isIconOnly variant="ghost" icon={compact ? <X /> : <ArrowLeft />} onClick={onBack} />
      <div className="flex min-w-0 items-center gap-2 max-[900px]:max-w-[210px]" data-testid="file-source"><Avatar id={a.by} size={24} status={false} mood="idle" /><span className="truncate text-[14px]">{people[a.by].name}</span><span className="text-fg-3">/</span><span className="truncate text-[14px] text-fg-2">{label}</span></div>
      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        {!compact && <ToggleButton label="相关对话" isIconOnly icon={<MessageSquare />} isPressed={contextOpen} onPressedChange={setContextOpen} data-testid="file-context-toggle" />}
        <Button label="接着聊" icon={<CornerUpLeft />} variant="primary" onClick={() => discussFile(a)} isDisabled={!conv} data-testid="file-discuss" />
      </div>
    </header>
    <div className="flex min-h-0 flex-1">
      <main className="scroll-thin min-w-0 flex-1 overflow-y-auto">
        <Card padding={0} className="mx-auto my-9 max-w-[780px] rounded-lg border border-line bg-elev px-12 pb-14 pt-10 shadow-soft max-[1150px]:mx-6 max-[1150px]:my-6 max-[1150px]:p-7 max-[900px]:mx-4 max-[900px]:p-6">
          <div className="mb-8 flex items-start justify-between gap-4"><h1 className="min-w-0 break-words text-[25px] font-semibold leading-snug tracking-tight [overflow-wrap:anywhere]">{a.name}</h1><span className="shrink-0 pt-1 text-[13px] text-fg-2">{a.meta}</span></div>
          <div data-testid="file-preview"><FileBody artifact={a} /></div>
        </Card>
      </main>
      {contextOpen && <aside data-testid="file-related" className="scroll-thin w-[290px] shrink-0 overflow-y-auto border-l border-line bg-side p-4 max-[1150px]:w-60 max-[900px]:absolute max-[900px]:bottom-0 max-[900px]:right-0 max-[900px]:top-[72px] max-[900px]:z-10 max-[900px]:w-[min(290px,80%)] max-[900px]:shadow-elev">
        <div className="mb-5 flex items-center justify-between"><h2 className="text-[15px] font-semibold">对话</h2><Button label="收起对话" isIconOnly variant="ghost" icon={<X />} onClick={() => setContextOpen(false)} /></div>
        <div className="space-y-3">{related.map((m) => <ClickableCard key={m.id} label={`查看原消息：${messageText(m)}`} padding={3} onClick={() => jump(m.id)} data-testid={`file-related-${m.id}`} className="bg-elev">
          {'from' in m && <div className="mb-2 flex items-center gap-2 text-[13px]"><Avatar id={m.from} size={20} status={false} mood="idle" /><span>{people[m.from].name}</span></div>}
          <p className="line-clamp-5 text-[14px] leading-relaxed">{messageText(m)}</p>
        </ClickableCard>)}</div>
        {!related.length && <p className="py-4 text-[14px] text-fg-2">没有相关消息</p>}
        {source && <div className="mt-4"><Button label="跳到原消息" variant="secondary" icon={<ArrowUpRight />} onClick={() => jump(source.id)} data-testid="file-jump" /></div>}
        {conv && <div className="mt-3"><Button label={`打开${label}`} variant="ghost" onClick={() => openConv(conv.id)} data-testid="file-open-conv" /></div>}
      </aside>}
    </div>
  </div>
}
