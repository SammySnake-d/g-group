import { useState } from 'react'
import { Eye, Search } from 'lucide-react'
import { ClickableCard } from '@astryxdesign/core/ClickableCard'
import { Button } from '@astryxdesign/core/Button'
import { TextInput } from '@astryxdesign/core/TextInput'
import { ToggleButton, ToggleButtonGroup } from '@astryxdesign/core/ToggleButton'
import { people, type Artifact } from '@/data'
import { useApp } from '@/store'
import { Avatar } from '../Avatar'
import { FILE_KINDS } from '@/app/list/labels'
import { FileCover } from './FileCover'
import { sourceLabel } from './context'

const PAGE_SIZE = 24

type Filter = 'all' | Artifact['kind']
export function FileShelf({ collection, query, onQuery, kind, onKind, onOpen, onPeek }: {
  collection: Artifact[]; query: string; onQuery: (v: string) => void; kind: Filter; onKind: (v: Filter) => void; onOpen: (id: string) => void; onPeek: (a: Artifact, keyboard?: boolean) => void
}) {
  const [limit, setLimit] = useState(PAGE_SIZE)
  const convs = useApp((s) => s.convs)
  const q = query.trim().toLocaleLowerCase()
  const list = collection.filter((a) => (kind === 'all' || kind === a.kind) && `${a.name} ${people[a.by].name} ${sourceLabel(convs.find((c) => c.id === a.conv))}`.toLocaleLowerCase().includes(q))
  return <main data-testid="files-main" data-file="" data-prototype="files" className="scroll-thin min-w-0 flex-1 overflow-y-auto px-6 py-8 xl:px-12">
    <header className="mb-6 flex flex-wrap items-center justify-between gap-6">
      <h1 className="text-[26px] font-semibold tracking-tight">文件</h1>
      <div className="w-full max-w-[260px]"><TextInput label="搜索文件" isLabelHidden placeholder="搜索文件" type="search" value={query} onChange={(v) => { onQuery(v); setLimit(PAGE_SIZE) }} startIcon={<Search className="h-4 w-4" />} size="lg" /></div>
    </header>
    <ToggleButtonGroup label="文件类型" type="single" value={kind} onChange={(v) => { onKind((v ?? 'all') as Filter); setLimit(PAGE_SIZE) }} className="mb-7 flex-wrap gap-1">
      <ToggleButton value="all" label="全部" />
      {FILE_KINDS.map((k) => <ToggleButton key={k.kind} value={k.kind} label={k.label} />)}
    </ToggleButtonGroup>
    <div className="grid max-w-[1200px] grid-cols-[repeat(auto-fill,minmax(min(250px,100%),1fr))] gap-x-6 gap-y-7" data-testid="file-shelf-grid">
      {list.slice(0, limit).map((a) => <div key={a.id} className="min-w-0" data-testid={`shelf-${a.id}`}>
        <ClickableCard label={`打开${a.name}`} onClick={() => onOpen(a.id)} padding={0} className="group relative overflow-hidden rounded-xl border border-line bg-elev shadow-soft" onKeyDown={(e) => { if (e.code === 'Space' && !e.repeat && e.target instanceof HTMLElement && e.target.getAttribute('aria-label') === `打开${a.name}`) { e.preventDefault(); e.stopPropagation(); onPeek(a, true) } }}>
          <FileCover artifact={a} />
          <div className="px-5 py-4">
            <h2 className="line-clamp-2 break-words text-[15px] font-semibold">{a.name}</h2>
            <div className="mt-2 flex min-w-0 items-center gap-2 text-[13px] text-fg-2"><Avatar id={a.by} size={20} status={false} mood="idle" /><span className="truncate">{people[a.by].name}</span><span className="ml-auto shrink-0">{a.when}</span></div>
          </div>
          <div className="absolute right-2.5 top-2.5 opacity-100 transition-opacity duration-fast group-hover:opacity-100 group-focus-within:opacity-100 motion-reduce:transition-none [@media(hover:hover)_and_(pointer:fine)]:opacity-0"><Button label={`快速查看${a.name}`} isIconOnly icon={<Eye className="h-4 w-4" />} variant="secondary" size="sm" onClick={() => onPeek(a)} tooltip="快速查看 · 空格" /></div>
        </ClickableCard>
      </div>)}
    </div>
    {list.length > limit && <div className="mt-8 flex justify-center"><Button label="显示更多" variant="secondary" onClick={() => setLimit((n) => n + PAGE_SIZE)} /></div>}
    {!list.length && <div className="flex min-h-64 flex-col items-center justify-center gap-4 text-[15px]"><p>没有找到文件</p><Button label="清除筛选" variant="secondary" onClick={() => { onQuery(''); onKind('all') }} /></div>}
  </main>
}
