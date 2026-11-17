import { ArrowDown } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { Button } from '@/components/ui/button'
import { rise } from '@/config/motion'

/* 回到最新:放在输入框正上方、阅读栏居中(#929:mirasim 放在显眼处,放角落观察成本高)。有新消息时写明条数。 */
export function JumpToLatest({ show, count, onJump }: { show: boolean; count: number; onJump: () => void }) {
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
      <AnimatePresence>
        {show && (
          <motion.div key="jump" {...rise} className="pointer-events-auto">
            <Button data-testid="to-bottom" variant="floating" size="sm" shape="pill" onClick={onJump} className={count > 0 ? 'text-me' : undefined}>
              <ArrowDown strokeWidth={2} />{count > 0 ? `${count} 条新消息` : '回到最新'}
            </Button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
