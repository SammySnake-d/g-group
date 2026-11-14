import { type MouseEvent, useEffect, useRef } from 'react'
import { toast } from 'sonner'
import { shellCall, useAppShell } from '@/api/app-shell'
import type { UpdateState } from '@/api/app-shell-types'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'

const TOAST_ID = 'gg-update'
/** 提示条上的按钮:sonner 默认点了就把提示关掉;这里要留着它显示下载进度、再给「重启并安装」 */
const keep = (fn: () => void) => (e: MouseEvent<HTMLButtonElement>) => { e.preventDefault(); fn() }
export const percent = (s: UpdateState) => (s.size ? Math.min(100, Math.floor(((s.received ?? 0) / s.size) * 100)) : 0)
export const mb = (n?: number) => (n ? `${(n / 1024 / 1024).toFixed(1)} MB` : '')

export const downloadUpdate = () => void shellCall('update.download', {})
export const installUpdate = () => void shellCall('update.install', {})
export const checkUpdate = () => void shellCall('update.check', {})

/* 有新版本时:一条常驻提示(不自动消失),下一步动作就在提示上——下载 → 进度 → 重启并安装。
   用户关掉这条提示后,同一个版本不再弹;设置页「版本与更新」里随时能接着做。 */
export function useUpdateToast() {
  const update = useAppShell((s) => s.update)
  const dismissed = useRef<string | null>(null)
  useEffect(() => {
    if (!update?.latest || dismissed.current === update.latest) return
    const v = update.latest
    const onDismiss = () => { dismissed.current = v }
    const base = { id: TOAST_ID, duration: Number.POSITIVE_INFINITY, onDismiss, closeButton: true }
    const line = (text: string) => <span data-testid="update-toast" data-phase={update.phase}>{text}</span>
    if (update.phase === 'available') toast(line(`g-group ${v} 可以更新了${update.size ? `（${mb(update.size)}）` : ''}`), { ...base, action: { label: '下载', onClick: keep(downloadUpdate) } })
    else if (update.phase === 'downloading') toast(line(`正在下载 ${v} · ${percent(update)}%`), { ...base, action: undefined })
    else if (update.phase === 'ready') toast(line(`${v} 已下载好，重启就是新版本`), { ...base, action: { label: '重启并安装', onClick: keep(installUpdate) } })
    else if (update.phase === 'installing') toast(line(`正在安装 ${v}，马上重开…`), { ...base, action: undefined, closeButton: false })
    else if (update.phase === 'error') toast(line(update.note ?? '更新没成功'), { ...base, action: { label: '重试', onClick: keep(update.note?.startsWith('下载失败') ? downloadUpdate : checkUpdate) } })
  }, [update])
}

/** 设置页「版本与更新」一行右侧:按当前进度给出下一步 */
export function UpdateAction() {
  const update = useAppShell((s) => s.update)
  if (!update) return null
  switch (update.phase) {
    case 'checking': return <span className="flex items-center gap-1.5 text-[12.5px] text-fg-3"><Spinner size="xs" tone="muted" />正在检查…</span>
    case 'available': return <Button data-testid="update-download" size="xs" variant="primary" onClick={downloadUpdate}>下载 {update.latest}</Button>
    case 'downloading': return <span data-testid="update-progress" className="text-[12.5px] tabular-nums text-fg-2">已下载 {percent(update)}%</span>
    case 'ready': return <Button data-testid="update-install" size="xs" variant="primary" onClick={installUpdate}>重启并安装 {update.latest}</Button>
    case 'installing': return <span className="flex items-center gap-1.5 text-[12.5px] text-fg-3"><Spinner size="xs" tone="muted" />正在安装…</span>
    case 'unsupported': return null
    default: return <Button data-testid="update-check" size="xs" variant="secondary" onClick={checkUpdate}>检查更新</Button>
  }
}
