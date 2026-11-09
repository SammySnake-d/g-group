// 启动参数:URL 只为走查脚本直达某个状态(?conv= ?section= ?split= ?freeze= …),界面里没有入口。
// 这里集中解析一次,各个切片只读结果,不再各自去翻 location。
import type { Section, SplitTab, WbTab } from './types'

const qs = new URLSearchParams(location.search)
if (import.meta.env.MODE === 'design' && !qs.has('section')) qs.set('section', 'files')

/** 冻结:演示里的定时推进、延迟回复都立即发生(走查截图要稳定) */
export const frozen = qs.get('freeze') !== null
/** 演示节拍倍速(?speed=2 快一倍) */
export const speed = +(qs.get('speed') ?? 1) || 1

export const uid = () => Math.random().toString(36).slice(2, 8)
export const clock = () => new Date().toTimeString().slice(0, 5)
/** 演示里的「过一会儿」:冻结时立即发生 */
export const later = (fn: () => void, ms: number) => setTimeout(fn, frozen ? 0 : ms)

function splitFromUrl(): SplitTab[] {
  const s = qs.get('split')
  if (!s) return []
  const [t, id, view] = s.split(':')
  return t === 'compute' ? [{ t, id, view: view as 'diff' }] : [{ t: 'artifact', id }]
}

export const boot = {
  fileFixture: (import.meta.env.DEV || import.meta.env.MODE === 'design') ? qs.get('files-fixture') : null,
  dark: qs.get('theme') === 'dark',
  /** ?section=activity 是旧链接:进展全景已经改成弹出遮罩(#1618),左侧停在聊天 */
  section: ((qs.get('section') === 'activity' ? 'chat' : qs.get('section')) as Section) ?? 'chat',
  panoOpen: qs.get('section') === 'activity',
  conv: qs.get('conv') ?? 'g',
  tabs: splitFromUrl(),
  contact: qs.get('contact') ?? 'claude',
  wbTab: (qs.get('wb') as WbTab) ?? 'overview',
  file: qs.get('file'),
  helperPanel: qs.get('hp') === '1',
  helperGlobal: qs.get('hg') === '1',
}
