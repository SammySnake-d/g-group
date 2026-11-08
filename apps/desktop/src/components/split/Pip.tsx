import { useState } from 'react'
import { motion } from 'motion/react'
import { Hand, X } from 'lucide-react'
import { people } from '@/data'
import { useApp } from '@/ctx'
import { rise } from '@/config/motion'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/icon-button'
import { Avatar } from '@/components/Avatar'
import { Preview } from './Preview'

/* Computer Use 小窗:可拖动,聊天时一直在(画中画)。从右下角浮起(transform-origin 右下),尊重 reduced-motion */
export function Pip({ id, onClose }: { id: string; onClose: () => void }) {
  const { computes } = useApp()
  const c = computes[id]
  const [pos, setPos] = useState({ x: 24, y: 96 })
  const [taken, setTaken] = useState(false)
  const owner = people[c.owner].name
  const drag = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('button')) return
    const sx = e.clientX, sy = e.clientY, ox = pos.x, oy = pos.y
    const mv = (ev: PointerEvent) => setPos({ x: Math.max(8, ox - (ev.clientX - sx)), y: Math.max(8, oy - (ev.clientY - sy)) })
    const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up) }
    window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up)
  }
  return (
    <motion.div
      data-testid="pip" initial={rise.initial} animate={rise.animate}
      className="fixed z-40 w-[320px] origin-bottom-right overflow-hidden rounded-2xl border border-line bg-elev shadow-elev"
      style={{ right: pos.x, bottom: pos.y }}
    >
      <div className="flex cursor-grab touch-none items-center gap-2 px-3 py-2 active:cursor-grabbing" onPointerDown={drag}>
        <Avatar id={c.owner} size={20} />
        <span className="min-w-0 flex-1 truncate text-[12.5px] text-fg-2">{taken ? '你在操作' : `${owner} 在浏览器里检查`}</span>
        <IconButton label="关闭小窗" tooltip={false} size="icon-xs" icon={<X />} onClick={onClose} className="text-fg-3" />
      </div>
      <div className="px-2"><Preview kind={c.preview ?? 'login'} small /></div>
      <div className="p-2">
        <Button variant={taken ? 'primary' : 'secondary'} size="sm" onClick={() => setTaken((t) => !t)} className="w-full text-[12.5px] [&_svg]:size-3.5">
          {taken ? `交还给 ${owner}` : <><Hand />我来操作</>}
        </Button>
      </div>
    </motion.div>
  )
}
