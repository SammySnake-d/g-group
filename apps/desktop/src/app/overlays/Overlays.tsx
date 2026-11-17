import { HelperGlobal } from '@/components/Helper'
import { FloatPanel } from '@/components/Overlays'
import { Pip } from '@/components/Split'
import { Toaster } from '@/components/ui/sonner'
import { useApp } from '@/store'
import { PanoOverlay } from './PanoOverlay'
import { RewindDialog } from './RewindDialog'

/** 盖在三栏之上的东西:右侧浮层栈(点空白处收起)、全局 Helper、画中画、进展全景、回退确认、提示条(sonner) */
export function Overlays() {
  const { stack, floatW, setFloatWidth, closeAll, helperGlobal, pip, pipRunning, showPip, dark } = useApp((s) => ({
    stack: s.stack, floatW: s.widths.float, setFloatWidth: s.setFloatWidth, closeAll: s.closeAll, helperGlobal: s.helperGlobal,
    pip: s.pip, pipRunning: !!s.pip && s.computes[s.pip]?.status === 'running', showPip: s.showPip, dark: s.dark,
  }))
  return (
    <>
      {stack.length > 0 && <div data-testid="scrim" className="absolute inset-0 z-20" onClick={closeAll} />}
      <FloatPanel stack={stack} width={floatW} onResize={setFloatWidth} />
      {helperGlobal && <HelperGlobal />}
      {pip && pipRunning && <Pip id={pip} onClose={() => showPip(null)} />}
      <PanoOverlay />
      <RewindDialog />
      {/* 提示条:顶部居中,从顶边进、往上划走(进出同一方向) */}
      <Toaster theme={dark ? 'dark' : 'light'} position="top-center" />
    </>
  )
}
