import { Dialog, IconButton } from '@astryxdesign/core'
import { X } from 'lucide-react'

/** 聊天与待发区共享原地预览，关闭后保留原会话和输入。 */
export function ImagePreview({ src, name, onClose }: { src: string; name: string; onClose: () => void }) {
  return <Dialog isOpen onOpenChange={(open) => { if (!open) onClose() }} purpose="info" aria-label={`图片预览：${name}`} width="min(1000px, 94vw)" maxHeight="92dvh" padding={3} className="gg-image-preview" data-testid="image-preview" style={{ animation: 'none', transition: 'none' }}>
    <div className="mb-2 flex items-center gap-3">
      <span className="min-w-0 flex-1 truncate text-[13px] text-fg-2">{name}</span>
      <IconButton label="关闭图片预览" icon={<X />} onClick={onClose} />
    </div>
    <img src={src} alt={name} className="mx-auto max-h-[78dvh] max-w-full object-contain" />
  </Dialog>
}
