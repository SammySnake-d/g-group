// A narrow addition to the original window, not a replacement composer/message tree.
import { createElement as h, useEffect, useState, useSyncExternalStore } from 'react'
import { ImageLightbox } from '@deepseek-ai/dsh-client-ui-primitives'
import { Attachments, USER_MESSAGE_CSS } from '../dsbot-base/upstream/ds-bot/src/client/user-message.js'
import { installStyles } from '../dsbot-base/upstream/ds-bot/src/client/styles.js'
import { call } from './bridge.ts'

installStyles(USER_MESSAGE_CSS, 'g-group-original-attachments')
installStyles(`
.gg-pending{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px}
.gg-pending-item{display:flex;align-items:center;gap:6px;max-width:280px;padding:5px 8px;border:1px solid var(--bt-line-2);border-radius:12px;background:var(--bt-card);color:var(--bt-ink);font-size:12px}
.gg-pending-item span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gg-pending-item img{width:40px;height:40px;object-fit:cover;border-radius:6px}
.gg-pending-item button{border:0;background:none;color:inherit;cursor:pointer;padding:4px}
.gg-row-attachments{display:flex;flex-wrap:wrap;gap:8px;margin:6px 0}
.gg-row-attachments[data-user]{justify-content:flex-end}
.gg-attachment-button{appearance:none;display:block;padding:0;border:0;background:transparent;color:var(--bt-ink);text-align:left;cursor:pointer;max-width:100%}
.gg-attachment-button:focus-visible{outline:2px solid var(--bt-ink-3);outline-offset:3px;border-radius:12px}
.gg-attachment-button img{display:block;max-width:min(320px,100%);max-height:240px;border-radius:16px}
.gg-file-download{display:flex;align-items:center;gap:5px;font-size:12px;color:var(--bt-ink-3);padding:3px 10px}
.gg-audio{max-width:320px;color:var(--bt-ink);font-size:12px}
.gg-row-attachments[data-user] .gg-file-download,.gg-row-attachments[data-user] .gg-audio{color:var(--bt-user-ink)}
.gg-audio audio{display:block;width:300px;max-width:100%;margin:5px 0}
.gg-attachment-error{color:var(--bt-danger,#b42318);font-size:12px;max-width:320px}
:root{--dsw-alias-bg-mask-1:rgba(0,0,0,.72);--dsw-alias-bg-base:var(--bt-card);--dsw-alias-text-primary:var(--bt-ink);--dsw-alias-text-white:#fff}
`, 'g-group-attachment-controls')

const pending = new Map()
const storeFor = id => {
  if (!pending.has(id)) pending.set(id, { items: [], listeners: new Set() })
  return pending.get(id)
}
const replaceItems = (store, items) => { store.items = items; store.listeners.forEach(listener => listener()) }
const readBase64 = file => new Promise((resolve, reject) => {
  const reader = new FileReader()
  reader.onload = () => resolve(String(reader.result).split(',')[1] || '')
  reader.onerror = () => reject(new Error(`无法读取 ${file.name}`))
  reader.readAsDataURL(file)
})

export function usePendingAttachments(sessionId, disabled) {
  const store = storeFor(sessionId)
  const items = useSyncExternalStore(listener => { store.listeners.add(listener); return () => store.listeners.delete(listener) }, () => store.items)
  const [error, setError] = useState(null)
  const [sending, setSending] = useState(false)
  useEffect(() => { setError(null) }, [sessionId])
  const remove = id => {
    const item = store.items.find(entry => entry.id === id)
    if (item?.url) URL.revokeObjectURL(item.url)
    replaceItems(store, store.items.filter(entry => entry.id !== id))
  }
  const add = files => {
    if (disabled || sending) return
    setError(null)
    for (const file of files) {
      // Backend upload allows 25 MB, but its download/read contract caps 16 MiB.
      // Never offer a send the same application cannot subsequently open in full.
      if (file.size > 16 * 1024 * 1024) { setError(`${file.name} 超过当前可完整读取的 16 MiB 上限，未添加`); continue }
      if (store.items.length >= 20) { setError('每条消息最多添加 20 个附件'); break }
      const entry = { id: crypto.randomUUID(), file, url: file.type.startsWith('image/') ? URL.createObjectURL(file) : null }
      replaceItems(store, [...store.items, entry])
    }
  }
  return {
    items, error, sending, add, remove,
    paste(event) {
      const files = [...(event.clipboardData?.files || [])]
      if (files.length) { event.preventDefault(); add(files) }
    },
    async send(text, onSend) {
      if (disabled || sending) return
      setSending(true); setError(null)
      const batch = [...store.items]
      try {
        const attachments = []
        for (const item of batch) {
          // Reuse completed uploads on a failed send; do not discard the draft.
          item.uploaded ??= await call('attachment-upload', { name: item.file.name, base64: await readBase64(item.file) })
          attachments.push(item.uploaded)
        }
        await onSend(text, attachments)
        batch.forEach(item => remove(item.id))
      } finally { setSending(false) }
    },
  }
}

export function PendingAttachments({ queue }) {
  return h('div', null,
    queue.error ? h('p', { role: 'alert', className: 'gg-attachment-error' }, queue.error) : null,
    queue.items.length ? h('div', { className: 'gg-pending', 'aria-label': '待发送附件' }, queue.items.map(item =>
      h('div', { className: 'gg-pending-item', key: item.id },
        item.url ? h('img', { src: item.url, alt: item.file.name }) : null,
        h('span', null, `${item.file.name} · ${Math.ceil(item.file.size / 1024)} KB`),
        h('button', { type: 'button', 'aria-label': `移除 ${item.file.name}`, disabled: queue.sending, onClick: () => queue.remove(item.id) }, '×')))) : null)
}

// Older g-group stores report voice files as application/octet-stream. Preserve
// that wire metadata; only choose a standard browser decoder by file extension.
const AUDIO_TYPES = { wav: 'audio/wav', mp3: 'audio/mpeg', m4a: 'audio/mp4', ogg: 'audio/ogg', opus: 'audio/ogg', flac: 'audio/flac', webm: 'audio/webm' }
const audioType = attachment => attachment.mime.startsWith('audio/') ? attachment.mime : AUDIO_TYPES[attachment.name.split('.').pop().toLowerCase()]

async function readFile(attachment) {
  const file = await call('file-read', { ref: attachment.ref })
  if (file.truncated) throw new Error('文件超过读取上限，未打开或下载截断内容')
  const bytes = file.encoding === 'base64' ? Uint8Array.from(atob(file.content), value => value.charCodeAt(0)) : file.content
  return new Blob([bytes], { type: audioType(attachment) || file.mime || 'application/octet-stream' })
}

function MediaAttachment({ attachment }) {
  const [url, setUrl] = useState(null)
  const [error, setError] = useState(null)
  const [open, setOpen] = useState(false)
  useEffect(() => {
    let active = true, objectUrl
    readFile(attachment).then(blob => {
      if (!active) return
      objectUrl = URL.createObjectURL(blob); setUrl(objectUrl)
    }).catch(failure => { if (active) setError(failure.message) })
    return () => { active = false; if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [attachment.ref])
  if (error) return h('p', { className: 'gg-attachment-error', role: 'alert' }, `${attachment.name}：${error}`)
  if (!url) return h('span', { className: 'gg-file-download' }, `正在读取 ${attachment.name}…`)
  if (audioType(attachment)) return h('div', { className: 'gg-audio' }, attachment.name,
    h('audio', { controls: true, preload: 'metadata', src: url, 'aria-label': attachment.name, onError: () => setError('当前浏览器不能解码这段音频') }),
    h('a', { href: url, download: attachment.name, className: 'gg-file-download' }, '下载音频'))
  return h('div', null,
    h('button', { type: 'button', className: 'gg-attachment-button', 'aria-label': `打开图片 ${attachment.name}`, onClick: () => setOpen(true) }, h('img', { src: url, alt: attachment.name })),
    open ? h(ImageLightbox, { src: url, alt: attachment.name, labels: { dialog: '查看图片', close: '关闭图片' }, onClose: () => setOpen(false) }) : null)
}

function FileAttachment({ attachment }) {
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const download = async () => {
    setError(null); setBusy(true)
    try {
      const blob = await readFile(attachment)
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url; anchor.download = attachment.name; anchor.click()
      setTimeout(() => URL.revokeObjectURL(url), 10_000)
    } catch (failure) { setError(failure.message) } finally { setBusy(false) }
  }
  return h('div', null,
    h('button', { type: 'button', className: 'gg-attachment-button', disabled: busy, 'aria-label': `下载 ${attachment.name}`, onClick: download },
      h(Attachments, { attachments: [{ type: 'file', attachment }] }),
      h('span', { className: 'gg-file-download' }, busy ? '正在读取…' : '↓ 下载')),
    error ? h('p', { role: 'alert', className: 'gg-attachment-error' }, error) : null)
}

export function MessageAttachments({ row }) {
  const files = row.attachments || []
  if (!files.length) return null
  return h('div', { className: 'gg-row-attachments', 'data-user': row.kind === 'user' ? '' : undefined }, files.map(attachment =>
    attachment.mime.startsWith('image/')
      ? h(Attachments, { key: attachment.ref, attachments: [{ type: 'image', attachment }], renderMessageImages: () => h(MediaAttachment, { attachment }) })
      : audioType(attachment) ? h(MediaAttachment, { key: attachment.ref, attachment }) : h(FileAttachment, { key: attachment.ref, attachment })))
}
