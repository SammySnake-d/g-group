import { useEffect } from 'react'
import { bridge, demoCalls, probeBackend } from '@/api/backend'
import { startWiring } from '@/api/wire'
import { useAppStore } from '@/store'
import { startLiveDemo } from '@/store/live'

/** 壳的副作用:探测后端、演示推进、全局快捷键(Esc 逐层退、⌘K 叫 Helper)、走查钩子 */
export function useShell() {
  /* 探测后端;连上了就启动接线(全量读 + 订阅事件流),卸载时退订 */
  useEffect(() => {
    let stop: (() => void) | null = null
    let gone = false
    void probeBackend().then((b) => {
      if (gone) return
      useAppStore.getState().setBackend(b)
      if (b.mode === 'connected' && bridge) stop = startWiring(useAppStore, bridge, b.eventSeq)
    })
    return () => { gone = true; stop?.() }
  }, [])
  useEffect(() => startLiveDemo(useAppStore), [])
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const s = useAppStore.getState()
      /* 弹层(Radix)自己处理过的 Esc 已被 preventDefault:只关那一层,不再连带收浮层或分栏 */
      if (e.key === 'Escape' && !e.defaultPrevented) s.escape()
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); s.setHelperGlobal(!s.helperGlobal) }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [])
  /* 走查用:模拟迟到的回答(AC-44⑤);核对演示服务收到了哪些合同调用。只挂在 window 上,界面里没有入口 */
  useEffect(() => { (window as unknown as { __gg?: unknown }).__gg = { returnHuman: useAppStore.getState().returnHuman, calls: () => demoCalls().map((c) => ({ method: c.method, ok: c.ok })) } }, [])
}
