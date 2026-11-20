import type { BackendState } from '@/api/backend'
import type { WireStatus } from '@/api/wire'
import { LAYOUT } from '@/config/layout'
import { notify } from '@/hooks/use-toast'
import type { PersonId } from '@/data'
import { boot } from '../boot'
import type { Slice } from '../state'
import type { Page, Section, SplitTab, WbTab } from '../types'

const SPLIT_INITIAL = 400
export type Pane = 'list' | 'split' | 'helper'

export interface LayoutCtx {
  dark: boolean
  debug: boolean
  setDark: (v: boolean) => void
  setDebug: (v: boolean) => void
  push: (p: Page, root?: boolean) => void
  back: () => void
  closeAll: () => void
  openSplit: (t: SplitTab) => void
  setPanoOpen: (v: boolean) => void
  /** 左侧当前所在的一级区域；从“进展”“联系人”打开东西时不切走它（#1387） */
  section: Section
  setSection: (s: Section) => void
  helperPanel: boolean
  setHelperPanel: (v: boolean) => void
  helperGlobal: boolean
  setHelperGlobal: (v: boolean) => void
  showPip: (cid: string | null) => void
  openContact: (id: PersonId, conv?: string, tab?: 'here' | 'talks' | 'process' | 'duty' | 'memory') => void
  /** 联系人工作台：主面板展开（#1334） */
  openWorkbench: (id: PersonId, tab?: WbTab) => void
  toast: (text: string) => void
}
export const LAYOUT_CTX_KEYS = ['dark', 'debug', 'setDark', 'setDebug', 'push', 'back', 'closeAll', 'openSplit', 'setPanoOpen', 'section', 'setSection', 'helperPanel', 'setHelperPanel', 'helperGlobal', 'setHelperGlobal', 'showPip', 'openContact', 'openWorkbench', 'toast'] as const satisfies readonly (keyof LayoutCtx)[]

export type LayoutSlice = LayoutCtx & {
  backend: BackendState
  /** 接线层的读取状态(api/wire):正在读 / 读完了、哪几类没读到 */
  wire: WireStatus
  setWire: (w: WireStatus) => void
  panoOpen: boolean
  stack: Page[]
  tabs: SplitTab[]
  tabIdx: number
  pip: string | null
  contact: PersonId
  wbTab: WbTab
  fileSel: string | null
  fileQuery: string
  setFileQuery: (q: string) => void
  fileReturn: { file: string; conv: string } | null
  setFileReturn: (r: { file: string; conv: string } | null) => void
  widths: Record<Pane | 'float', number>
  setBackend: (b: BackendState) => void
  pickTab: (i: number) => void
  closeTab: (i: number) => void
  closeTabs: () => void
  pickContact: (id: PersonId) => void
  setWbTab: (t: WbTab) => void
  setFileSel: (id: string | null) => void
  resize: (pane: Pane, delta: number) => void
  setFloatWidth: (w: number) => void
  escape: () => void
}

export const createLayoutSlice: Slice<LayoutSlice> = (set, get) => ({
  backend: { mode: 'checking' },
  wire: { phase: 'off' },
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
  fileQuery: '',
  fileReturn: null,
  helperPanel: boot.helperPanel,
  helperGlobal: boot.helperGlobal,
  widths: { list: LAYOUT.list.initial, split: SPLIT_INITIAL, float: LAYOUT.float.initial, helper: LAYOUT.helper.initial },

  setBackend: (backend) => set({ backend }),
  setWire: (wire) => set({ wire }),
  setDark: (dark) => { set({ dark }); document.documentElement.classList.toggle('dark', dark) },
  setDebug: (debug) => set({ debug }),
  setSection: (section) => set({ section, fileReturn: null }),
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
  setFileQuery: (fileQuery) => set({ fileQuery }),
  setFileReturn: (fileReturn) => set({ fileReturn }),

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
