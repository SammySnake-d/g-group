import { useState } from 'react'
import { Dialog } from '@astryxdesign/core/Dialog'
import { artifacts, type Artifact } from '@/data'
import { useApp } from '@/store'
import { FileShelf } from './files/FileShelf'
import { FileReader } from './files/FileReader'
import { fileDataset } from './files/fixtures'
import { boot } from '@/store/boot'

// 先认出交付物；来处在阅读页头一行，说话回到原对话。
export function FilesMain({ id }: { id: string | null }) {
  const setFileSel = useApp((s) => s.setFileSel)
  const [peek, setPeek] = useState<Artifact | null>(null)
  /* 文件还没接后端(files.list):连上后端时不列演示文件 */
  const live = useApp((s) => s.backend.mode === 'connected')
  const collection = fileDataset(boot.fileFixture, live ? [] : artifacts)
  const [keyboardPeek, setKeyboardPeek] = useState(false)
  const a = collection.find((f) => f.id === id)
  return <>
    {a ? <FileReader key={a.id} artifact={a} onBack={() => setFileSel(null)} /> : <FileShelf collection={collection} onOpen={setFileSel} onPeek={(item, keyboard = false) => { setKeyboardPeek(keyboard); setPeek(item) }} />}
    <Dialog className={keyboardPeek ? "animate-none [--duration-medium-max:0ms]" : "[--duration-medium-max:var(--dur-base)]"} isOpen={!!peek} onOpenChange={(v) => { if (!v) setPeek(null) }} width="min(900px, calc(100vw - 48px))" maxHeight="85dvh" padding={0} aria-label={peek?.name ?? '文件预览'}>
      {peek && <div className="flex h-[72dvh] min-h-0"><FileReader key={peek.id} artifact={peek} onBack={() => setPeek(null)} compact /></div>}
    </Dialog>
  </>
}
