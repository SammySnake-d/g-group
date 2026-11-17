import * as D from '@animate-ui/react/primitives/radix-ui/dialog'
import { X } from 'lucide-react'
import { useRef } from 'react'
import { Panorama } from '@/components/Panorama'
import { IconButton } from '@/components/ui/icon-button'
import { useApp } from '@/store'

/* 进展全景:弹出的对话框,不是一级页面(#1618:进度不是需要时刻打开的)。
   关掉再开,筛选和滚动位置都还在(Panorama 模块级 saved)。进出场交给 Animate UI 的 Dialog。 */
export function PanoOverlay() {
  const { open, setOpen } = useApp((s) => ({ open: s.panoOpen, setOpen: s.setPanoOpen }))
  const box = useRef<HTMLDivElement>(null)
  return (
    <D.Root open={open} onOpenChange={setOpen}>
      <D.Portal>
        <D.Overlay data-testid="pano-overlay" className="fixed inset-0 z-40 bg-black/30 backdrop-blur-[2px]" />
        <D.Content ref={box} tabIndex={-1} aria-describedby={undefined} onOpenAutoFocus={(e) => { e.preventDefault(); box.current?.focus() }}
          className="fixed inset-0 z-40 m-auto flex h-[min(860px,92vh)] w-[min(1280px,94vw)] overflow-hidden rounded-2xl border border-line bg-bg text-fg shadow-elev outline-none">
          <D.Title className="sr-only">进展全景</D.Title>
          <D.Close asChild>
            <IconButton data-testid="pano-close" label="关闭（Esc）" className="absolute right-3 top-3 z-10" icon={<X />} />
          </D.Close>
          <Panorama />
        </D.Content>
      </D.Portal>
    </D.Root>
  )
}
