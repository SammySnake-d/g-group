/* U87 / D23 / AC-40:交代那一行的文字和跳转目标(纯计算,界面在 DispLine) */
import { dispText, type Compute, type Disp } from '@/data'
import { cronRule } from '@/components/CronDetail'
import { useApp } from '@/ctx'

const short = (t?: string) => (t && t.length > 10 ? t.slice(0, 10) + '…' : t)

function refNameOf(d: Disp, computes: Record<string, Compute>, crons: ReturnType<typeof useApp>['crons']) {
  if (d.refKind === 'compute') return computes[d.ref!]?.title
  if (d.refKind === 'cron') { const c = crons.find((x) => x.id === d.ref); return c ? `${cronRule(c)} 的定时` : '' }
  return ''
}

export function dispLabel(d: Disp, refName?: string) {
  if (d.kind === 'merged') return `合并到「${short(refName) || '…'}」`
  if (d.kind === 'superseded') return '被后面那条替代'
  if (d.kind === 'doing' && refName) return `在做「${short(refName)}」`
  if (d.kind === 'done' && refName) return `已做「${short(refName)}」`
  return dispText[d.kind]
}

export function useDisp(d: Disp) {
  const { openSplit, jump, computes, crons } = useApp()
  const go = () => (d.refKind === 'compute' ? openSplit({ t: 'compute', id: d.ref! }) : d.refKind === 'cron' ? openSplit({ t: 'cron', id: d.ref! }) : d.ref && jump(d.ref))
  return { label: dispLabel(d, refNameOf(d, computes, crons)), go }
}
