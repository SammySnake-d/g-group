import { useState } from 'react'
import { Dialog } from '@astryxdesign/core/Dialog'
import { artifacts, type Artifact } from '@/data'
import { useApp } from '@/store'
import { FileShelf } from './files/FileShelf'
import { FileReader } from './files/FileReader'
import { fileDataset } from './files/fixtures'
import { boot } from '@/store/boot'

// 一页两种工作姿态：先认出交付物，再安静读；说话回到它所属的对话。
export function FilesMain({ id }: { id: string | null }) {
  const setFileSel = useApp((s) => s.setFileSel)
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState<'all' | Artifact['kind']>('all')
  const [peek, setPeek] = useState<Artifact | null>(null)
  const collection = fileDataset(boot.fileFixture, artifacts)
  const [keyboardPeek, setKeyboardPeek] = useState(false)
  const a = collection.find((f) => f.id === id)
  return <>
    {a ? <FileReader key={a.id} artifact={a} onBack={() => setFileSel(null)} /> : <FileShelf collection={collection} query={query} onQuery={setQuery} kind={kind} onKind={setKind} onOpen={setFileSel} onPeek={(item, keyboard = false) => { setKeyboardPeek(keyboard); setPeek(item) }} />}
    <Dialog className={keyboardPeek ? "animate-none [--duration-enter:0ms] [--duration-exit:0ms]" : undefined} isOpen={!!peek} onOpenChange={(v) => { if (!v) setPeek(null) }} width="min(900px, calc(100vw - 48px))" maxHeight="85dvh" padding={0} aria-label={peek?.name ?? '文件预览'}>
      {peek && <div className="flex h-[72dvh] min-h-0"><FileReader key={peek.id} artifact={peek} onBack={() => setPeek(null)} compact /></div>}
    </Dialog>
  </>
}
