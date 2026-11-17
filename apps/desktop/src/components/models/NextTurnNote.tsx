import { motion } from 'motion/react'
import { Check } from 'lucide-react'
import { resolveCompute, resolveSpeaking, type ContactModels, type NextTurn } from '@g-group/ui-core'
import { rise } from '@/config/motion'
import { harnessLabel, type ModelSettings } from '@/modelConfig'

/** U93:改了下一轮就生效,正在跑的这一轮不打断 */
export function NextTurnNote({ n, s, c, name, running }: { n: NextTurn; s: ModelSettings; c: ContactModels; name: string; running: string[] }) {
  const r = resolveCompute(c, s)
  return (
    <motion.div data-testid="next-turn" role="status" initial={rise.initial} animate={rise.animate} className="flex flex-1 items-start gap-2 rounded-xl bg-run-soft px-3 py-2 text-[12.5px]">
      <Check aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0 text-run" strokeWidth={2.5} />
      <div className="min-w-0 space-y-0.5">
        <div className="font-medium">已保存，下一轮生效，不用再手动切。</div>
        {n.speaking && <div className="text-fg-2">{name} 下一次说话用 <code className="font-mono text-fg">{resolveSpeaking(c).value}</code></div>}
        {n.compute.length > 0 && <div className="text-fg-2">Compute 下一次输入用 <code className="font-mono text-fg">{r.model.value} · {r.harness.value} · {r.effort.value}</code></div>}
        {n.harnessSwitch && <div className="text-fg-2">换了 Harness：下一轮在 {harnessLabel(r.harness.value)} 上开新会话，之前的任务和约束由软件带过去。</div>}
        <div className="text-fg-2">{n.running > 0 ? `正在跑的 ${n.running} 个任务这一轮不打断，按启动时的 ${[...new Set(running)].join('、')} 跑完。` : '正在跑的这一轮不打断。现在没有在跑的。'}</div>
      </div>
    </motion.div>
  )
}
