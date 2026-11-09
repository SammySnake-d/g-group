import { scale, spring, transition } from '@/config/motion'
import { slow } from '../shared/slowmo'

/* 按印:印从纸面上方落下、压实。数值全部取自 Animate UI 的 token,不另拍——
   - 起点比纸面「高」一档:popover 从 scale.popover 长到 1(朝你弹出来),印反过来,从 1 / scale.popover 落回 1(朝纸面压下去);
   - 落下用 spring.checkPop:库里给「勾选确认」用的那根弹簧,落地有一点点回弹,像印泥压实;
   - 透明度用 transition.fade,和落下同时开始,不等。 */
export const stamp = {
  initial: { opacity: 0, scale: 1 / scale.popover },
  animate: { opacity: 1, scale: 1, transition: { scale: slow(spring.checkPop), opacity: slow(transition.fade) } },
} as const

/** 打开会话时已经验收过的:印就在那里,不动 */
export const stampStill = { initial: false, animate: { opacity: 1, scale: 1 } } as const
