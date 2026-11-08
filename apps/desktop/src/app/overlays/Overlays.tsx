import { HelperGlobal } from '@/components/Helper'
import { FloatPanel } from '@/components/Overlays'
import { Pip } from '@/components/Split'
import { useApp } from '@/store'
import { PanoOverlay } from './PanoOverlay'
import { RewindDialog } from './RewindDialog'

/** 盖在三栏之上的东西:右侧浮层栈(点空白处收起)、全局 Helper、画中画、进展全景、回退确认、提示条 */
export function Overlays() {
  const { stack, floatW, setFloatWidth, closeAll, helperGlobal, pip, pipRunning, showPip, toastMsg } = useApp((s) => ({
    stack: s.stack, floatW: s.widths.float, setFloatWidth: s.setFloatWidth, closeAll: s.closeAll, helperGlobal: s.helperGlobal,
    pip: s.pip, pipRunning: !!s.pip && s.computes[s.pip]?.status === 'running', showPip: s.showPip, toastMsg: s.toastMsg,
  }))
  return (
    <>
      {stack.length > 0 && <div data-testid="scrim" className="absolute inset-0 z-20" onClick={closeAll} />}
      <FloatPanel stack={stack} width={floatW} onResize={setFloatWidth} />
      {helperGlobal && <HelperGlobal />}
      {pip && pipRunning && <Pip id={pip} onClose={() => showPip(null)} />}
      <PanoOverlay />
      <RewindDialog />
      {toastMsg && <div data-testid="toast" className="fade-up pointer-events-none absolute left-1/2 top-4 z-50 -translate-x-1/2 rounded-full bg-btn px-4 py-1.5 text-[13px] text-btn-fg shadow-elev">{toastMsg}</div>}
    </>
  )
}
