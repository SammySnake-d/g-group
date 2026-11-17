import type { SlashInvocation } from '@g-group/ui-core'
import { AtSign, FolderClosed, History, Image as ImageIcon, Scissors, Slash, Smile } from 'lucide-react'
import { motion } from 'motion/react'
import { useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/icon-button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { COMPOSER_EMOJI } from '@/config/emoji'
import { rise } from '@/config/motion'
import type { Artifact, Conversation } from '@/data'
import { broken } from '@/mut'
import { live } from '@/api/wire/live'
import { shellCall } from '@/api/app-shell'
import { useApp } from '@/store'
import { SourcePicker } from './SourcePicker'

type Props = {
  conv: Conversation
  inv: SlashInvocation | null
  canSend: boolean
  /** 每按一次回车但参数不全 +1:「还差 …」闪一下 */
  nudge: number
  onInsert: (s: string) => void
  onAt: () => void
  onSlash: () => void
  /** file:选中的本地文件或当前窗口截图;宿主持久化后发出。 */
  onFile: (name: string, kind: Artifact['kind'], meta: string, file?: File) => void | Promise<void>
  onSubmit: () => void
}

/* 输入框底部工具栏:左边取外部消息、表情、@、/、截图、文件、图片;右边缺什么 + 发送。
   全部 32px 命中区,提示同组里第一个有延迟、后面即时(TooltipProvider 的 skipDelay)。 */
export function Toolbar({ conv, inv, canSend, nudge, onInsert, onAt, onSlash, onFile, onSubmit }: Props) {
  const { push, toast, isLive } = useApp((s) => ({ push: s.push, toast: s.toast, isLive: live(s) }))
  const fileRef = useRef<HTMLInputElement>(null)
  const imgRef = useRef<HTMLInputElement>(null)
  const [capturing, setCapturing] = useState(false)
  const capture = async () => {
    const name = `截图 ${new Date().toTimeString().slice(0, 8).replaceAll(':', '-')}.png`
    if (!isLive) return onFile(name, 'asset', '1440×900 · 你截的')
    if (capturing) return
    setCapturing(true)
    try {
      const r = await shellCall('window.capture', {})
      if (!r.ok) { toast(`没截到图：${r.error}`); return }
      const bytes = Uint8Array.from(atob(r.value.base64), (c) => c.charCodeAt(0))
      await onFile(name, 'asset', `${r.value.width}×${r.value.height} · 你截的`, new File([bytes], name, { type: 'image/png' }))
    } catch (e) {
      toast(`截图没发出去：${e instanceof Error ? e.message : String(e)}`)
    } finally { setCapturing(false) }
  }
  const pick = (e: React.ChangeEvent<HTMLInputElement>, kind: Artifact['kind']) => {
    for (const f of Array.from(e.target.files ?? [])) onFile(f.name, kind, `${(f.size / 1024).toFixed(0)} KB · 你发的`, f)
    e.target.value = ''
  }
  return (
    <div className="flex items-center gap-0.5 px-1.5 pb-1.5">
      <SourcePicker conv={conv} />
      <Popover>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild><IconButton data-testid="tool-emoji" label="表情" tooltip={false} icon={<Smile strokeWidth={1.6} />} /></PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent>表情</TooltipContent>
        </Tooltip>
        <PopoverContent side="top" align="start" className="grid w-[312px] grid-cols-8 gap-0.5 rounded-xl border-line bg-elev p-2 shadow-elev">
          {COMPOSER_EMOJI.map((e) => <Button key={e} variant="ghost" size={null} aria-label={e} onClick={() => onInsert(e)} className="h-9 w-9 text-[20px]">{e}</Button>)}
        </PopoverContent>
      </Popover>
      <IconButton data-testid="tool-at" label="@ 某人（第一项是 Helper）" onClick={onAt} icon={<AtSign strokeWidth={1.6} />} />
      <IconButton data-testid="tool-slash" label="命令（也可以直接打 /）" onMouseDown={(e) => e.preventDefault()} onClick={onSlash} icon={<Slash strokeWidth={2} />} />
      <IconButton data-testid="tool-shot" label={capturing ? '正在发送截图' : '截图（截当前窗口发出去）'} disabled={capturing} onClick={() => void capture()} icon={<Scissors strokeWidth={1.6} />} />
      <IconButton data-testid="tool-file" label="文件" onClick={() => fileRef.current?.click()} icon={<FolderClosed strokeWidth={1.6} />} />
      <IconButton data-testid="tool-image" label="图片" onClick={() => imgRef.current?.click()} icon={<ImageIcon strokeWidth={1.6} />} />
      <input ref={fileRef} data-testid="file-input" type="file" multiple hidden onChange={(e) => pick(e, 'doc')} />
      <input ref={imgRef} data-testid="image-input" type="file" accept="image/*" multiple hidden onChange={(e) => pick(e, 'asset')} />
      {broken('AC-50-2') && <IconButton data-testid="tool-history" label="聊天记录" onClick={() => push({ t: 'search', id: conv.id }, true)} icon={<History strokeWidth={1.6} />} />}
      <div className="min-w-0 flex-1" />
      {inv && inv.missing.length > 0 && (
        <motion.span key={nudge} initial={nudge > 0 ? rise.initial : false} animate={rise.animate} data-testid="slash-missing" className={nudge > 0 ? 'mr-2 truncate text-[12px] font-medium text-warm' : 'mr-2 truncate text-[12px] text-warm'}>还差 {inv.missing.join('、')}</motion.span>
      )}
      <Button data-testid="send" variant="primary" onClick={onSubmit} disabled={!canSend} title="Enter 发送 · Shift+Enter 换行" className="px-4 text-[13.5px]">{inv ? '执行' : '发送'}</Button>
    </div>
  )
}
