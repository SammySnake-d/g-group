import { shift, spring, transition } from '@/config/motion'

/* 浮层与页面切换的动效(只用于本模块)。没有现成的 Animate UI 原语对应「非模态侧浮层」和「浮层内压栈」,
   所以按共同规则第 ③ 档:motion + config/motion 再导出的库 token,一个数值都不自己写(用户 #976)。
   - 浮层:从右侧移入 shift.navigation,位移走 spring.slide、透明度走 transition.fade;
     退场只移 shift.handoff、用 transition.panelOut(库里退场比进场快)
   - 浮层里压栈/返回:新页从前进方向移入 shift.tabs(和库里页签切换同一个位移);旧页立即让位,不叠两份同样的控件
   - prefers-reduced-motion:不位移,只剩淡入淡出 */

export const panel = {
  initial: { opacity: 0, x: shift.navigation },
  animate: { opacity: 1, x: 0, transition: { x: spring.slide, opacity: transition.fade } },
  exit: { opacity: 0, x: shift.handoff, transition: transition.panelOut },
} as const

export const panelReduced = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: transition.fade },
  exit: { opacity: 0, transition: transition.panelOut },
} as const

/** dir:1 = 压栈(从右来),-1 = 返回(从左来) */
export const pageIn = (dir: 1 | -1, reduced: boolean | null) =>
  reduced
    ? { initial: { opacity: 1 }, animate: { opacity: 1 } }
    : { initial: { opacity: 0, x: shift.tabs * dir }, animate: { opacity: 1, x: 0, transition: { x: spring.slide, opacity: transition.fade } } }

/** 卡片/行出现(确认卡、新消息):库里 handoff 的位移和弹簧 */
export const appear = {
  initial: { opacity: 0, y: shift.handoff },
  animate: { opacity: 1, y: 0, transition: { y: spring.handoff, opacity: transition.fade } },
} as const

/** 侧栏/分屏打开:和浮层同一套,但只进不出(分屏的收起由布局直接让位) */
export const paneIn = {
  initial: { opacity: 0, x: shift.navigation },
  animate: { opacity: 1, x: 0, transition: { x: spring.slide, opacity: transition.fade } },
} as const
