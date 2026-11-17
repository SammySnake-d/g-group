import { cn } from '@/lib/utils'
import type { Compute } from '@/data'
import { Tip } from '@/components/Messages'

/* 步骤条:每一步一小段,一眼看到走到第几步。颜色只表达状态,悬停有步骤名(颜色不单独表达含义):
   做完 = 弱墨;当前一步 = 在跑绿 / 等你橙 / 停下灰;失败 = 红;没开始 = 分隔线色(比底色深,看得出总共几步) */
const segCls = (c: Compute, state: Compute['steps'][number]['state']) =>
  state === 'done' ? 'bg-fg-3/60'
  : state === 'now' ? (c.status === 'running' ? 'bg-run' : c.status === 'waiting' ? 'bg-warm-dot' : 'bg-fg-3')
  : state === 'fail' ? 'bg-err'
  : 'bg-line'

export function StepBar({ c }: { c: Compute }) {
  const done = c.steps.filter((s) => s.state === 'done').length
  /* 没有步骤计划(后端的任务合同里没有)就不画空条 */
  if (!c.steps.length) return null
  return (
    <div className="mx-5 flex gap-1" data-testid="stepbar" role="img" aria-label={`共 ${c.steps.length} 步，做完 ${done} 步`}>
      {c.steps.map((s, i) => (
        <Tip key={i} label={s.text}>
          <div className={cn('h-1 flex-1 rounded-full transition-colors duration-base ease-out', segCls(c, s.state))} />
        </Tip>
      ))}
    </div>
  )
}
