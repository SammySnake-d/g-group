import { useEffect } from 'react'
import { ArrowLeft } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { Button } from '@/components/ui/button'
import { rise } from '@/config/motion'
import { useApp } from '@/store'
import { fileList } from '@/store/slices/files'

/* 来回:从文件的来处跳进聊天,看完上下文一下回到那份文件(Telegram 跳到被引用消息后的「回去」同一个习惯)。
   只在跳进来的那个对话里出现;换对话、走导航就作废,不留成常驻入口。 */
export function FileReturn({ conv }: { conv: string }) {
  const { ret, setRet, setFileSel, setSection } = useApp((s) => ({ ret: s.fileReturn, setRet: s.setFileReturn, setFileSel: s.setFileSel, setSection: s.setSection }))
  useEffect(() => { if (ret && ret.conv !== conv) setRet(null) }, [conv, ret, setRet])
  const files = useApp(fileList)
  const file = ret && ret.conv === conv ? files.find((a) => a.id === ret.file) : undefined
  return (
    <div className="pointer-events-none absolute inset-x-0 top-3 z-10 flex justify-center">
      <AnimatePresence>
        {file && (
          <motion.div key="file-return" {...rise} className="pointer-events-auto max-w-[70%]">
            <Button data-testid="file-return" variant="floating" size="sm" shape="pill" aria-label={`回到文件「${file.name}」`}
              onClick={() => { setSection('files'); setFileSel(file.id) }} className="max-w-full">
              <ArrowLeft strokeWidth={2} /><span className="truncate">{file.name}</span>
            </Button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
