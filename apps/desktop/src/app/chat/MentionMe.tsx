import { AtSign } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { Button } from '@/components/ui/button'
import { rise } from '@/config/motion'
import type { Conversation, Msg } from '@/data'
import { useApp } from '@/store'

const MY_HANDLE = '@39impacts'

export function MentionMe({ conv, show }: { conv: Conversation; show: boolean }) {
  const jump = useApp((s) => s.jump)
  const hit = show ? ([...conv.messages].reverse().find((m) => m.k === 'text' && m.from !== 'me' && m.text.includes(MY_HANDLE)) as Extract<Msg, { k: 'text' }> | undefined)?.id : undefined
  return (
    <div className="pointer-events-none absolute inset-x-0 top-3 flex justify-center">
      <AnimatePresence>
        {hit && (
          <motion.div key="at-me" {...rise} className="pointer-events-auto origin-top">
            <Button data-testid="at-me" variant="floating" size="sm" shape="pill" onClick={() => jump(hit)} className="border-warm/30 bg-warm-soft text-warm hover:bg-warm-soft"><AtSign />有人 @ 了你</Button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
