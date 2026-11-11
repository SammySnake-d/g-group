/* 连上后端时文件的正文与缩略:附件和任务产出用 files.read 取,交付带回的工件快照用 artifacts.get 取。
   文本照原样排(保留换行),图片直接显示,其余只写类型和大小——不编内容、不画占位图形。
   同一份文件(按文件号 + 大小)只取一次,缩略和阅读页共用。 */
import { useEffect, useState } from 'react'
import { FileText } from 'lucide-react'
import { call } from '@/api/backend'
import { sizeOf } from '@/api/wire/files'
import type { Artifact } from '@/data'
import { cn } from '@/lib/utils'

type Live = NonNullable<Artifact['live']>
type Content = { kind: 'text'; text: string; truncated: boolean } | { kind: 'image'; src: string } | { kind: 'other' } | { kind: 'error'; message: string }

const PREVIEW_BYTES = 512 * 1024
const cache = new Map<string, Promise<Content>>()

async function fetchContent(f: Live): Promise<Content> {
  if (f.via === 'artifact') {
    const r = await call('artifacts.get', { ref: f.ref })
    if (!r.ok) return { kind: 'error', message: r.error.message }
    return r.value.text != null ? { kind: 'text', text: r.value.text, truncated: false } : { kind: 'other' }
  }
  const r = await call('files.read', { ref: f.ref, maxBytes: PREVIEW_BYTES })
  if (!r.ok) return { kind: 'error', message: r.error.message }
  if (r.value.encoding === 'text') return { kind: 'text', text: r.value.content, truncated: r.value.truncated }
  if (r.value.mime.startsWith('image/') && !r.value.truncated) return { kind: 'image', src: `data:${r.value.mime};base64,${r.value.content}` }
  return { kind: 'other' }
}

function useContent(f: Live): Content | null {
  const key = `${f.ref}|${f.bytes}`
  const [c, setC] = useState<Content | null>(null)
  useEffect(() => {
    let off = false
    let p = cache.get(key)
    if (!p) { p = fetchContent(f); cache.set(key, p); p.then((x) => { if (x.kind === 'error') cache.delete(key) }) }
    void p.then((x) => { if (!off) setC(x) })
    return () => { off = true }
  }, [key]) // eslint-disable-line react-hooks/exhaustive-deps
  return c
}

/** 阅读页正文 */
export function LiveFileBody({ file }: { file: Live }) {
  const c = useContent(file)
  if (!c) return <div className="min-h-40" aria-busy="true" />
  if (c.kind === 'error') return <p className="py-8 text-[14px] text-fg-2" role="alert">打不开这份文件：{c.message}</p>
  if (c.kind === 'image') return <img src={c.src} alt="" className="max-h-[70vh] max-w-full rounded-md border border-line" />
  if (c.kind === 'other') return <p className="py-8 text-[14px] text-fg-2">这类文件（{file.mime || '未知类型'} · {sizeOf(file.bytes)}）没法在这里预览，可以「接着聊」让联系人说说里面是什么。</p>
  return <>
    <article data-testid="file-text" className="whitespace-pre-wrap break-words text-[15px] leading-[1.9] [overflow-wrap:anywhere]">{c.text}</article>
    {c.truncated && <p className="mt-6 text-[13px] text-fg-2">只显示了前 {sizeOf(PREVIEW_BYTES)}，全文 {sizeOf(file.bytes)}。</p>}
  </>
}

const cover = 'h-52 border-b border-line bg-bg'

/** 文件区缩略:正文开头几行 / 图片 / 类型 */
export function LiveFileCover({ file }: { file: Live }) {
  const c = useContent(file)
  if (c?.kind === 'image') return <div className={cn(cover, 'overflow-hidden')}><img src={c.src} alt="" className="h-full w-full object-cover" /></div>
  if (c?.kind === 'text') return <div className={cn(cover, 'overflow-hidden px-6 py-5')}><FileText className="mb-3 h-5 w-5 text-fg-2" /><p className="line-clamp-6 whitespace-pre-wrap break-words text-[13px] leading-relaxed text-fg-2">{c.text}</p></div>
  return <div className={cn(cover, 'flex flex-col justify-between p-6')} aria-busy={!c}><FileText className="h-5 w-5 text-fg-3" /><span className="text-[13px] text-fg-2">{file.mime || '文件'} · {sizeOf(file.bytes)}</span></div>
}
