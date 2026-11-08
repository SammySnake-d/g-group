import { useRef } from 'react'
import { motion, useReducedMotion } from 'motion/react'
import { useApp } from '@/ctx'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { stamp, stampStill } from './motion'

/* 概念 · 朱印验收
   「纸·墨·柿」里的柿红,本来就是纸上朱砂印泥的颜色。验收是一个回合的终点:你在汇报下面回一句「通过」,
   那条汇报的落款处(气泡右下角)按下一枚柿红小印。只认清单里这件事真的到了「已完成」,不认已读、不认表情。
   打开会话时已经验收过的,印直接在那里,不再重放;只有你亲手验收的那一下才有「按下去」的动作。 */
export function AcceptSeal({ computeId }: { computeId: string }) {
  const { checklist, computes } = useApp()
  const item = checklist.find((x) => x.attempts.includes(computeId))
  const accepted = item?.status === '已完成'
  /* 挂载时就已验收 → 静止的印;挂载后才变成已验收 → 播一次按印 */
  const atMount = useRef(accepted)
  const reduce = useReducedMotion()
  if (!accepted) return null
  const fresh = !atMount.current
  const title = computes[computeId]?.title ?? item?.text ?? ''
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <motion.span
          data-testid={`seal-${computeId}`}
          data-state={fresh ? 'stamped' : 'kept'}
          role="img"
          aria-label={`已验收：${title}`}
          {...(fresh && !reduce ? stamp : stampStill)}
          className="absolute -right-[24px] bottom-[3px] z-[1] grid h-[32px] w-[32px] select-none place-items-center rounded-[5px] border-[1.5px] border-brand text-brand mix-blend-multiply shadow-[inset_0_0_0_2px_hsl(var(--theirs)),inset_0_0_0_2.75px_hsl(var(--brand)/.55)] dark:mix-blend-normal dark:shadow-[inset_0_0_0_2px_hsl(var(--bg)),inset_0_0_0_2.75px_hsl(var(--brand)/.55)]"
          style={{ rotate: -8, fontFamily: '"Songti SC", "STSong", "Noto Serif CJK SC", serif' }}
        >
          <span className="flex flex-col items-center text-[12px] font-bold leading-[12px] tracking-normal">
            <span>验</span>
            <span>收</span>
          </span>
        </motion.span>
      </TooltipTrigger>
      <TooltipContent side="top">你验收通过了「{title}」</TooltipContent>
    </Tooltip>
  )
}
