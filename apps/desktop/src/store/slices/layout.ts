// 界面布局切片:一级区域、右侧浮层栈、分栏页签、画中画、Helper 面板、各栏宽度、主题、提示条。
import type { BackendState } from '@/api/backend'
import { LAYOUT } from '@/config/layout'
import { notify } from '@/hooks/use-toast'
import type { PersonId } from '@/data'
import { boot } from '../boot'
import type { Slice } from '../state'
import type { Ctx, Page, Section, SplitTab, WbTab } from '../types'

/** 分栏默认宽度沿用拆分前的 400(config/layout 的 split.initial 是 440,改不改由底座决定,见回报) */
const SPLIT_INITIAL = 400
export type Pane = 'list' | 'split' | 'helper'

export type LayoutSlice = Pick<Ctx, 'dark' | 'debug' | 'setDark' | 'setDebug' | 'push' | 'back' | 'closeAll' | 'openSplit' | 'setPanoOpen' | 'section' | 'setSection'
  | 'helperPanel' | 'setHelperPanel' | 'helperGlobal' | 'setHelperGlobal' | 'showPip' | 'openContact' | 'openWorkbench' | 'toast'> & {
  backend: BackendState
  panoOpen: boolean
  /** 右侧浮层:一摞页面 */
  stack: Page[]
  /** 右侧分栏:多页签 */
  tabs: SplitTab[]
  tabIdx: number
  pip: string | null
  /** 通讯录里选中的联系人、工作台页签;文件区选中的文件 */
  contact: PersonId
  wbTab: WbTab
  fileSel: string | null
  widths: Record<Pane | 'float', number>
  setBackend: (b: BackendState) => void
  pickTab: (i: number) => void
  closeTab: (i: number) => void
  closeTabs: () => void
  pickContact: (id: PersonId) => void
  setWbTab: (t: WbTab) => void
  setFileSel: (id: string) => void
  /** 拖动分隔条:按位移调宽,夹在 config/layout 的范围里 */
  resize: (pane: Pane, delta: number) => void
  setFloatWidth: (w: number) => void
  /** Esc:先退一层浮层,再收分屏(全景 → 全局 Helper → 多选 → 浮层栈 → 分栏) */
  escape: () => void
}

export const createLayoutSlice: Slice<LayoutSlice> = (set, get) => ({
  backend: { mode: 'checking' },
  dark: boot.dark,
  debug: false,
  section: boot.section,
  panoOpen: boot.panoOpen,
  stack: [],
  tabs: boot.tabs,
  tabIdx: 0,
  pip: null,
  contact: boot.contact,
  wbTab: boot.wbTab,
  fileSel: boot.file,
  helperPanel: boot.helperPanel,
  helperGlobal: boot.helperGlobal,
  widths: { list: LAYOUT.list.initial, split: SPLIT_INITIAL, float: LAYOUT.float.initial, helper: LAYOUT.helper.initial },

  setBackend: (backend) => set({ backend }),
  setDark: (dark) => { set({ dark }); document.documentElement.classList.toggle('dark', dark) },
  setDebug: (debug) => set({ debug }),
  setSection: (section) => set({ section }),
  setPanoOpen: (panoOpen) => set({ panoOpen }),
  setHelperPanel: (helperPanel) => set({ helperPanel }),
  setHelperGlobal: (helperGlobal) => set({ helperGlobal }),
  showPip: (pip) => set({ pip }),
  toast: (text) => notify(text),

  push: (p, root) => set((s) => ({ stack: root ? [p] : [...s.stack, p] })),
  back: () => set((s) => ({ stack: s.stack.slice(0, -1) })),
  closeAll: () => set({ stack: [] }),
  /* 打开详情不切走左侧所在的区域(#1387):在「进展」里打开,左侧仍停在进展 */
  openSplit: (t) => {
    const ts = get().tabs
    const i = ts.findIndex((x) => x.t === t.t && x.id === t.id)
    if (i >= 0) set({ tabIdx: i, tabs: ts.map((x, j) => (j === i ? t : x)) })
    else set({ tabIdx: ts.length, tabs: [...ts, t] })
  },
  pickTab: (tabIdx) => set({ tabIdx }),
  closeTab: (i) => set((s) => ({ tabs: s.tabs.filter((_, j) => j !== i), tabIdx: Math.max(0, s.tabIdx - (i <= s.tabIdx ? 1 : 0)) })),
  closeTabs: () => set({ tabs: [] }),
  openContact: (id, conv, tab) => { set({ stack: [] }); get().openSplit({ t: 'contact', id, conv, tab }) },
  openWorkbench: (id, tab) => set({ section: 'contacts', contact: id, wbTab: tab ?? 'overview', stack: [] }),
  pickContact: (contact) => set({ contact, wbTab: 'overview' }),
  setWbTab: (wbTab) => set({ wbTab }),
  setFileSel: (fileSel) => set({ fileSel }),

  resize: (pane, delta) => set((s) => {
    const r = LAYOUT[pane]
    return { widths: { ...s.widths, [pane]: Math.max(r.min, Math.min(r.max, s.widths[pane] + delta)) } }
  }),
  setFloatWidth: (w) => set((s) => ({ widths: { ...s.widths, float: w } })),

  escape: () => {
    const s = get()
    if (s.panoOpen) set({ panoOpen: false })
    else if (s.helperGlobal) set({ helperGlobal: false })
    else if (s.selecting) s.setSelecting(false)
    else if (s.stack.length) s.back()
    else if (s.tabs.length) set({ tabs: [] })
  },
})

export type { Section }
