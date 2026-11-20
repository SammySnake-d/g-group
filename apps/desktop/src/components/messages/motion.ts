import { useEffect, useState } from 'react'
import { useShouldReduceMotion } from '@animate-ui/react/utils/motion'
import { scale, transition } from '@/config/motion'

/* 消息里的动效参数一律取 src/config/motion.ts 再导出的 Animate UI token(用户 #976),这里只做组合,不写数值。
   折叠/展开直接用 Animate UI 的 Collapsible(自带高度弹簧、边缘渐隐和减少动态处理);
   悬浮工具条必须常驻 DOM 才能先量尺寸再定位,所以没用挂载式的 Fade/Zoom 效果,而是用同一套 token 在显隐两态之间切换。 */

export function useBarReveal() {
  const reduce = useShouldReduceMotion()
  return {
    hidden: { opacity: 0, scale: reduce ? 1 : scale.choice, transition: transition.popOut },
    shown: { opacity: 1, scale: 1, transition: transition.fade },
  }
}

export function useNoEnterOnMount() {
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  return mounted ? undefined : transition.instant
}
