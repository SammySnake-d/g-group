import type { ReactNode } from 'react'
import { BadgeCheck } from 'lucide-react'
import { CATEGORY_LABEL, RISK_LABEL, type PluginCategory, type RiskLevel } from '@g-group/ui-core'
import { Chip, chipVariants } from '@/components/ui/chip'
import { cn } from '@/lib/utils'
import { OFFICIAL_PUBLISHER, RISK_TONE } from './constants'

export function PluginIcon({ m, size = 40, className }: { m: { icon: { letter: string; color: string } }; size?: number; className?: string }) {
  return (
    <span aria-hidden className={cn('grid shrink-0 select-none place-items-center font-semibold text-white shadow-soft', className)}
      style={{ width: size, height: size, borderRadius: Math.round(size * 0.27), background: m.icon.color, fontSize: Math.round(size * ([...m.icon.letter].length > 1 ? 0.33 : 0.42)) }}>
      {m.icon.letter}
    </span>
  )
}

export function CategoryTag({ c, className }: { c: PluginCategory; className?: string }) {
  return <Chip tone="neutral" className={className}>{CATEGORY_LABEL[c]}</Chip>
}

export function RiskBadge({ r, className }: { r: RiskLevel; className?: string }) {
  return <Chip data-risk={r} tone={RISK_TONE[r]} className={className}>{RISK_LABEL[r]}风险</Chip>
}

export function CommandTag({ children, hit, className }: { children: ReactNode; hit?: boolean; className?: string }) {
  return <code className={cn(chipVariants({ tone: hit ? 'link' : 'neutral' }), 'font-code', className)}>{children}</code>
}

export function Publisher({ name, className }: { name: string; className?: string }) {
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-1', className)}>
      {name === OFFICIAL_PUBLISHER && <BadgeCheck aria-hidden className="h-3.5 w-3.5 shrink-0 text-me" />}
      <span className="truncate">{name}</span>
    </span>
  )
}

export const Spinner = () => <span aria-hidden className="spin-ring" />
