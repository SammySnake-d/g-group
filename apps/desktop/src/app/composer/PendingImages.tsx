import { useEffect, useState } from 'react'
import { AspectRatio, ClickableCard, IconButton } from '@astryxdesign/core'
import { X } from 'lucide-react'
import { ImagePreview } from '@/components/messages/cards/ImagePreview'
import { imageDraftOf, loadImageDraft, removeDraftImages, useImageDrafts, type DraftImage } from './imageDrafts'

function DraftThumb({ image, room, sending }: { image: DraftImage; room: string; sending: boolean }) {
  const [src, setSrc] = useState('')
  const [open, setOpen] = useState(false)
  useEffect(() => { const url = URL.createObjectURL(image.file); setSrc(url); return () => URL.revokeObjectURL(url) }, [image.file])
  return <div className="relative shrink-0" data-pending-image={image.id}>
    <ClickableCard label={`预览 ${image.name}`} onClick={() => setOpen(true)} width={80} padding={0} className="overflow-hidden rounded-lg">
      <AspectRatio ratio={1} fit="cover"><img src={src} alt={image.name} /></AspectRatio>
    </ClickableCard>
    <span className="absolute -right-1 -top-1 rounded-full bg-elev shadow-soft"><IconButton label={`移除 ${image.name}`} icon={<X size={14} />} isDisabled={sending} onClick={() => void removeDraftImages(room, [image.id])} /></span>
    {open && src && <ImagePreview src={src} name={image.name} onClose={() => setOpen(false)} />}
  </div>
}
export function PendingImages({ room }: { room: string }) {
  const d = useImageDrafts((s) => s.rooms[room]) ?? imageDraftOf(room)
  useEffect(() => { void loadImageDraft(room) }, [room])
  if (!d.images.length && !d.error) return null
  return <div data-testid="composer-images" data-saved={String(d.saved)} className="px-3 pt-3">
    <div className="flex gap-3 overflow-x-auto pb-2 pt-1">{d.images.map((image) => <DraftThumb key={image.id} image={image} room={room} sending={d.sending} />)}</div>
    {d.error && <p role="alert" className="pb-2 text-[12px] text-err">{d.error}</p>}
  </div>
}
