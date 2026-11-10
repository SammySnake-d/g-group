import { useState } from 'react'
import { Eye } from 'lucide-react'
import { ClickableCard } from '@astryxdesign/core/ClickableCard'
import { Button } from '@astryxdesign/core/Button'
import { people, type Artifact } from '@/data'
import { useApp } from '@/store'
import { Avatar } from '../Avatar'
import { FileCover } from './FileCover'
import { matchFile } from './context'

const PAGE_SIZE = 24

// 没选文件时的总览:按内容认文件。搜索用左边列表栏那一个,这里不再放第二个搜索框和类别筛选。
export function FileShelf({ collection, onOpen, onPeek }: {
  collection: Artifact[]; onOpen: (id: string) => void; onPeek: (a: Artifact, keyboard?: boolean) => void
}) {
  const { convs, query, setQuery } = useApp((s) => ({ convs: s.convs, query: s.fileQuery, setQuery: s.setFileQuery }))
  // 换了搜索词就从第一页重新数
  const [paging, setPaging] = useState({ q: query, n: PAGE_SIZE })
  const limit = paging.q === query ? paging.n : PAGE_SIZE
  const list = collection.filter((a) => matchFile(a, query, convs))
  return <main data-testid="files-main" data-file="" data-prototype="files" className="scroll-thin min-w-0 flex-1 overflow-y-auto px-6 py-6 xl:px-10">
    <h1 className="sr-only">文件</h1>
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
    {list.length > limit && <div className="mt-8 flex justify-center"><Button label="显示更多" variant="secondary" onClick={() => setPaging({ q: query, n: limit + PAGE_SIZE })} /></div>}
    {!list.length && <div className="flex min-h-64 flex-col items-center justify-center gap-4 text-[15px]"><p>没有找到文件</p><Button label="清除搜索" variant="secondary" onClick={() => setQuery('')} /></div>}
  </main>
}
