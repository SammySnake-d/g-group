import { ArrowLeft, ArrowUpRight, CornerUpLeft, MessageSquare, X } from 'lucide-react'
import { Button } from '@astryxdesign/core/Button'
import { ToggleButton } from '@astryxdesign/core/ToggleButton'
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
  return <div data-testid="files-main" data-file={a.id} data-prototype="file-reader" className="file-reader flex min-h-0 min-w-0 flex-1 flex-col">
    <header className="file-reader-toolbar">
      <Button label={compact ? '关闭预览' : '全部文件'} isIconOnly variant="ghost" icon={compact ? <X /> : <ArrowLeft />} onClick={onBack} />
      <div className="flex min-w-0 items-center gap-2" data-testid="file-source"><Avatar id={a.by} size={24} status={false} mood="idle" /><span className="truncate text-[14px]">{people[a.by].name}</span><span className="text-fg-3">/</span><span className="truncate text-[14px] text-fg-2">{label}</span></div>
      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        {!compact && <ToggleButton label="相关对话" isIconOnly icon={<MessageSquare />} isPressed={contextOpen} onPressedChange={setContextOpen} data-testid="file-context-toggle" />}
        <Button label="接着聊" icon={<CornerUpLeft />} variant="primary" onClick={() => discussFile(a)} isDisabled={!conv} data-testid="file-discuss" />
      </div>
    </header>
    <div className="flex min-h-0 flex-1">
      <main className="scroll-thin min-w-0 flex-1 overflow-y-auto">
        <div className="file-paper">
          <div className="mb-8 flex items-start justify-between gap-4"><h1 className="text-[25px] font-semibold leading-snug tracking-tight">{a.name}</h1><span className="shrink-0 pt-1 text-[13px] text-fg-2">{a.meta}</span></div>
          <div data-testid="file-preview"><FileBody artifact={a} /></div>
        </div>
      </main>
      {contextOpen && <aside data-testid="file-related" className="file-context scroll-thin overflow-y-auto border-l border-line bg-side p-4">
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
