/* ============ Compute:在聊天里只占一行,点开在右侧分屏看 ============
   这一块(ComputeLine / StatusDot / useComputeView)只做了机械迁移:拆文件、换原语,视觉保持原样。
   用户 #1005 要求重做 Compute 卡,由 R5 在 src/components/compute/ 里做 ComputeCard,合并后整块替换这里。 */
import type { MouseEvent } from 'react'
import { ChevronRight, Hand, PauseCircle } from 'lucide-react'
import { people } from '@/data'
import { useApp } from '@/ctx'
import { broken } from '@/mut'
import { Button } from '@/components/ui/button'
import { Pressable } from '../Pressable'
import { StatusDot } from './StatusDot'
import { useComputeView } from './useComputeView'

const LINE = 'flex max-w-full shrink gap-1.5 rounded-full text-[12.5px]'
const stop = (run: () => void) => (e: MouseEvent) => { e.stopPropagation(); run() }

export function ComputeLine({ id }: { id: string }) {
  const { openSplit, resolve, takeHuman, returnHuman, hitCaptcha, declineHuman } = useApp()
  const v = useComputeView(id)
  if (!v) return null
  const { c, view, stepsDone, err } = v
  const open = stop(() => openSplit({ t: 'compute', id }))

  /* AC-14 停滞:换成黄色一行写明多久没动、卡在哪一步;联系人会自己出来 @你 */
  if (view === 'stalled') return (
    <Pressable data-testid={`compute-line-${id}`} data-state="stalled" onClick={open} className={`${LINE} bg-warm-soft py-0.5 pl-2 pr-2.5`}>
      <PauseCircle className="h-3.5 w-3.5 text-warm" /><span className="truncate font-medium">{c.title}</span>
      <span className="shrink-0 text-warm">· <span className="tabular-nums">{c.idleMin}</span> 分钟没动静 · 卡在「{c.steps.find((x) => x.state === 'now')?.text}」</span>
    </Pressable>
  )

  /* C-US15:卡在只有人能过的一步,原地交给你;接手后小窗打开,过了点交还 */
  if (view === 'human') return (
    <div data-testid={`compute-line-${id}`} data-state="human" className="flex max-w-full items-center gap-2 rounded-full bg-warm-soft py-0.5 pl-2 pr-1 text-[12.5px]">
      <Hand className="h-3.5 w-3.5 shrink-0 text-warm" />
      <Pressable onClick={open} className="block min-w-0 shrink truncate font-medium hover:underline">{c.title}</Pressable>
      <span className="shrink-0 text-warm">· {c.needsHuman!.taken ? '你在操作' : c.needsHuman!.what + '，要你来'}</span>
      {c.needsHuman!.taken
        ? <Button data-testid={`human-return-${id}`} onClick={stop(() => returnHuman(id))} variant="primary" size="xs" shape="pill" className="h-6 bg-me text-me-fg hover:bg-me/90 text-[12px]">交还给 {people[c.owner].name}</Button>
        : <>
          <Button data-testid={`human-take-${id}`} onClick={stop(() => takeHuman(id))} variant="primary" size="xs" shape="pill" className="h-6 text-[12px]">我来输入</Button>
          <Button data-testid={`human-decline-${id}`} onClick={stop(() => declineHuman(id))} variant="ghost" size="xs" shape="pill" className="h-6 px-2 text-[12px] font-normal">不做了</Button>
        </>}
    </div>
  )

  /* 出错:红字一行;AC-36 失败原地给三条路:重试 / 换个模型 / 跳过这一步(跳过后汇报里写明跳过了什么) */
  if (view === 'error') return (
    <div data-testid={`compute-line-${id}`} data-state="error" onClick={open} className="flex max-w-full cursor-pointer items-center gap-2 border-l-2 border-err py-1 pl-2.5 pr-1 text-[13px]">
      <StatusDot c={c} />
      <Pressable onClick={open} className="block min-w-0 shrink truncate font-semibold text-err hover:underline">{c.title}</Pressable>
      <span className="min-w-0 truncate text-err/90">{c.error ?? '出错了'}</span>
      {err && <Button data-testid={`retry-${id}`} onClick={stop(() => resolve(err.id, 'retry'))} variant="danger" size="xs" className="ml-1 border border-err/40">重试</Button>}
      {err && !broken('AC-36') && <Button data-testid={`switch-${id}`} onClick={stop(() => resolve(err.id, 'switch'))} variant="ghost" size="xs" className="px-2 font-normal">换个模型</Button>}
      {err && !broken('AC-36') && <Button data-testid={`skip-${id}`} onClick={stop(() => resolve(err.id, 'skip'))} variant="ghost" size="xs" className="px-2 font-normal">跳过</Button>}
    </div>
  )

  if (view === 'done') return (
    <Pressable data-testid={`compute-line-${id}`} data-state="done" onClick={open} className={`${LINE} truncate px-2 py-0.5 text-[12px] text-fg-3 hover:bg-hover`}>
      <StatusDot c={c} className="h-3 w-3" /><span className="truncate">{c.title}</span><span className="shrink-0">· {c.result ?? '已完成'}</span>
    </Pressable>
  )

  return (
    <Pressable data-testid={`compute-line-${id}`} data-state={c.status} data-cver={c.cver ?? 1} onClick={open} className={`${LINE} group/c -ml-0.5 gap-2 truncate py-1 pl-2.5 pr-2 text-[13px] text-fg-2 hover:bg-hover`}>
      <StatusDot c={c} />
      <span className="truncate font-medium text-fg">{c.title}</span>
      <span className="shrink-0 text-run" data-testid={`compute-phase-${id}`}>{c.status === 'stopped' ? '已停止' : c.phase}</span>
      {c.status === 'running' && <span className="shrink-0 tabular-nums text-fg-3">第 {Math.min(stepsDone + 1, c.steps.length)}/{c.steps.length} 步 · {c.elapsed}</span>}
      <ChevronRight className="h-3.5 w-3.5 text-fg-3 transition-transform duration-fast ease-out group-hover/c:translate-x-0.5" />
      {id === 'logs' && c.status === 'running' && <span data-testid="demo-captcha" role="button" onClick={stop(() => hitCaptcha(id))} className="ml-1 shrink-0 rounded px-1.5 text-[11.5px] text-fg-3 hover:bg-hover hover:text-fg">演示：遇到验证码</span>}
    </Pressable>
  )
}
