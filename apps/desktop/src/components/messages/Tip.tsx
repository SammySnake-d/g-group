import type { ReactNode } from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

/** 通用悬停提示:样子与延迟都交给 ui/tooltip 和 App 的 TooltipProvider(组内首个有延迟、后续即时),和 IconButton 的提示一致。
 *  只有图标的按钮直接用 IconButton(它自带提示和无障碍名),不要再包 Tip。 */
export function Tip({ label, children, side }: { label: string; children: ReactNode; side?: 'top' | 'right' | 'bottom' | 'left' }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side}>{label}</TooltipContent>
    </Tooltip>
  )
}
