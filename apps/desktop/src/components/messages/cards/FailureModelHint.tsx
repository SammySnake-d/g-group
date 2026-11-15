import { people } from '@/data'
import { useApp } from '@/ctx'
import { Button } from '@/components/ui/button'
import type { TextMsg } from '../types'

/** 宿主给失败原因与重试动作；桌面补齐当前模型和可操作的设置入口。 */
export function FailureModelHint({ m }: { m: TextMsg }) {
  const { modelSettings, openWorkbench } = useApp()
  const c = m.card
  if (c?.kind !== 'failure') return null
  const model = people[m.from]?.model ?? modelSettings.defaultSpeakingModel
  return <div data-testid={`failure-model-${m.id}`} className="mt-2 max-w-full text-[12.5px] text-fg-2">
    <p className="break-all">当前说话模型：{model}。可到「联系人设置 → 模型」更换；网关地址或令牌请在「设置 → 模型接入」检查。</p>
    <Button size="xs" variant="outline" onClick={() => openWorkbench(m.from, 'settings')}>更换说话模型</Button>
    {c.body && <details className="mt-1"><summary className="cursor-pointer text-fg-3">失败原因详情</summary><pre className="mt-1 whitespace-pre-wrap break-all font-sans text-[12px]">{c.body}</pre></details>}
  </div>
}
