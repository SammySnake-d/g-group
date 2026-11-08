import { ease, scale, shift, spring, toCssTiming, transition } from '@animate-ui/react/utils/motion'

// 动效参数一律取自 Animate UI 的 motion tokens,不由我们自己拍数值。
// 用户 #976:「移动多少、速度多少，渐变、延迟时间等等这种需要资深设计师和动画师去考虑的，而llm很难把握这个度。我们直接用动画库的话就很方便」
// 弹层、菜单、提示、对话框、开关等交给 src/components/ui 里的 Animate UI 原语;这里只给少数自己组装的进出场用。
export { ease, scale, shift, spring, transition }

/** 浮起的小控件(回到最新、有人 @ 你):库里 popover 的出现方式——从 0.8 缩放淡入,弹簧 pop;退场用 popOut,比进场快 */
export const rise = {
  initial: { opacity: 0, scale: scale.popover, y: shift.handoff },
  animate: { opacity: 1, scale: 1, y: 0, transition: spring.pop },
  exit: { opacity: 0, scale: scale.popover, y: shift.handoff, transition: transition.popOut },
} as const

/** 折叠/展开:高度走库里的 height 弹簧,内容淡入用 fade;收起用 panelOut */
export const collapse = {
  initial: { height: 0, opacity: 0 },
  animate: { height: 'auto', opacity: 1, transition: { height: spring.height, opacity: transition.fade } },
  exit: { height: 0, opacity: 0, transition: transition.panelOut },
} as const

/** CSS 侧(悬停变色、按下缩放)的时长与曲线:从同一套 token 换算后写到根元素变量,tailwind 的 duration-fast|base|slow、ease-out 读它们 */
export function applyMotionCssVars(root: HTMLElement = document.documentElement) {
  const ms = (t: Parameters<typeof toCssTiming>[0]) => `${toCssTiming(t).duration}ms`
  const bezier = (c: readonly number[]) => `cubic-bezier(${c.join(', ')})`
  root.style.setProperty('--dur-fast', ms(transition.popOut))
  root.style.setProperty('--dur-base', ms(transition.color))
  root.style.setProperty('--dur-slow', ms(transition.reveal))
  root.style.setProperty('--ease-out', bezier(ease.out))
  root.style.setProperty('--ease-in-out', bezier(ease.inOut))
}
