// 图片是客户端会话草稿：点发送之前不上传、不生成消息、不唤醒联系人。
// Blob 留在当前应用 profile 的 IndexedDB，不进入宿主的 Agent 草稿。
import { create } from 'zustand'

export interface DraftImage { id: string; name: string; file: File }
interface ImageDraft { images: DraftImage[]; ready: boolean; saved: boolean; sending: boolean; error?: string }
const EMPTY: ImageDraft = { images: [], ready: false, saved: false, sending: false }
export const useImageDrafts = create<{ rooms: Record<string, ImageDraft> }>(() => ({ rooms: {} }))
export const imageDraftOf = (room: string) => useImageDrafts.getState().rooms[room] ?? EMPTY
const change = (room: string, f: (d: ImageDraft) => ImageDraft) => useImageDrafts.setState((s) => ({ rooms: { ...s.rooms, [room]: f(s.rooms[room] ?? EMPTY) } }))
let db: Promise<IDBDatabase> | undefined
function open() {
  return db ??= new Promise<IDBDatabase>((resolve, reject) => {
    const r = indexedDB.open('gg-client-image-drafts', 1)
    r.onupgradeneeded = () => r.result.createObjectStore('rooms')
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => { db = undefined; reject(r.error) }
  })
}
const loading = new Map<string, Promise<void>>()
export function loadImageDraft(room: string): Promise<void> {
  if (imageDraftOf(room).ready) return Promise.resolve()
  let p = loading.get(room)
  if (!p) {
    p = (async () => {
      try {
        const store = (await open()).transaction('rooms').objectStore('rooms')
        const rows = await new Promise<DraftImage[]>((resolve, reject) => {
          const r = store.get(room)
          r.onsuccess = () => resolve(r.result ?? [])
          r.onerror = () => reject(r.error)
        })
        const images = rows.map((x) => ({ ...x, file: new File([x.file], x.name, { type: x.file.type }) }))
        change(room, (d) => ({ ...d, images, ready: true, saved: true }))
      } catch {
        change(room, (d) => ({ ...d, ready: true, error: '图片草稿未能读回；请重新选择图片。' }))
      } finally { loading.delete(room) }
    })()
    loading.set(room, p)
  }
  return p
}
const writes = new Map<string, Promise<void>>()
async function persist(room: string) {
  const images = imageDraftOf(room).images
  change(room, (d) => ({ ...d, saved: false }))
  const p = (writes.get(room) ?? Promise.resolve()).then(async () => {
    const database = await open()
    await new Promise<void>((resolve, reject) => {
      const t = database.transaction('rooms', 'readwrite')
      if (images.length) t.objectStore('rooms').put(images, room)
      else t.objectStore('rooms').delete(room)
      t.oncomplete = () => resolve()
      t.onerror = () => reject(t.error)
      t.onabort = () => reject(t.error)
    })
    if (imageDraftOf(room).images === images) change(room, (d) => ({ ...d, saved: true, error: undefined }))
  }).catch(() => change(room, (d) => ({ ...d, error: '图片草稿未能保存，关闭应用前请发送或重新选择。' })))
  writes.set(room, p)
  await p
  if (writes.get(room) === p) writes.delete(room)
}
export async function addDraftImages(room: string, files: readonly File[]) {
  await loadImageDraft(room)
  const images = files.filter((f) => f.type.startsWith('image/')).map((file) => ({ id: crypto.randomUUID(), name: file.name || '粘贴图片.png', file }))
  if (!images.length) return
  change(room, (d) => ({ ...d, images: [...d.images, ...images] }))
  await persist(room)
}
export async function removeDraftImages(room: string, ids: readonly string[]) {
  change(room, (d) => ({ ...d, images: d.images.filter((x) => !ids.includes(x.id)) }))
  await persist(room)
}
export const setImageSending = (room: string, sending: boolean) => change(room, (d) => ({ ...d, sending }))
