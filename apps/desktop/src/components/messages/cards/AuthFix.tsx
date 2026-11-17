/* AC-35⑤:凭据失效时外发立即阻断,联系人在群里发一条红字修复卡;点「重新授权」恢复 */
import { AlertTriangle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useApp } from '@/ctx'
import { Button } from '@/components/ui/button'
import type { MsgOf } from '../types'

export function AuthFix({ m }: { m: MsgOf<'authfix'> }) {
  const { reauthPlugin } = useApp()
  return (
    <div data-testid={`authfix-${m.plugin}`} data-fixed={m.fixed ? '1' : undefined} className={cn('flex items-center gap-2 rounded-[14px] border px-3 py-2 text-[13.5px]', m.fixed ? 'border-line text-fg-3' : 'border-err/40 bg-err-soft text-err')}>
      <AlertTriangle className="h-4 w-4 shrink-0" /><span className="flex-1">{m.fixed ? '已重新授权，外发恢复' : m.text}</span>
      {!m.fixed && <Button data-testid={`authfix-go-${m.plugin}`} onClick={() => reauthPlugin(m.plugin)} variant="danger-solid" size="xs">重新授权</Button>}
    </div>
  )
}
