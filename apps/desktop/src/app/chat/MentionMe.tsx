import { AtSign } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { Button } from '@/components/ui/button'
import { rise } from '@/config/motion'
import type { Conversation, Msg } from '@/data'
import { useApp } from '@/store'

/** 你在群里的 @ 名 */
const MY_HANDLE = '@39impacts'

/** 往上翻着看的时候,最近一条 @ 你的消息浮在右上角,点了跳过去 */
export function MentionMe({ conv, show }: { conv: Conversation; show: boolean }) {
  const jump = useApp((s) => s.jump)
  const hit = show ? ([...conv.messages].reverse().find((m) => m.k === 'text' && m.from !== 'me' && m.text.includes(MY_HANDLE)) as Extract<Msg, { k: 'text' }> | undefined)?.id : undefined
  return (
    <div className="pointer-events-none absolute right-5 top-3">
      <AnimatePresence>
        {hit && (
          <motion.div key="at-me" {...rise} className="pointer-events-auto origin-top-right">
            <Button data-testid="at-me" variant="floating" size="sm" shape="pill" onClick={() => jump(hit)} className="border-warm/30 bg-warm-soft text-warm hover:bg-warm-soft"><AtSign />有人 @ 了你</Button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
