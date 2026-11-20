import { ease, scale, shift, spring, toCssTiming, transition } from '@animate-ui/react/utils/motion'

// 用户 #976:「移动多少、速度多少，渐变、延迟时间等等这种需要资深设计师和动画师去考虑的，而llm很难把握这个度。我们直接用动画库的话就很方便」
export { ease, scale, shift, spring, transition }

export const rise = {
  initial: { opacity: 0, scale: scale.popover, y: shift.handoff },
  animate: { opacity: 1, scale: 1, y: 0, transition: spring.pop },
  exit: { opacity: 0, scale: scale.popover, y: shift.handoff, transition: transition.popOut },
} as const

export const collapse = {
  initial: { height: 0, opacity: 0 },
  animate: { height: 'auto', opacity: 1, transition: { height: spring.height, opacity: transition.fade } },
  exit: { height: 0, opacity: 0, transition: transition.panelOut },
} as const

export function applyMotionCssVars(root: HTMLElement = document.documentElement) {
  const ms = (t: Parameters<typeof toCssTiming>[0]) => `${toCssTiming(t).duration}ms`
  const bezier = (c: readonly number[]) => `cubic-bezier(${c.join(', ')})`
  root.style.setProperty('--dur-fast', ms(transition.popOut))
  root.style.setProperty('--dur-base', ms(transition.color))
  root.style.setProperty('--dur-slow', ms(transition.reveal))
  root.style.setProperty('--ease-out', bezier(ease.out))
  root.style.setProperty('--ease-in-out', bezier(ease.inOut))
}
