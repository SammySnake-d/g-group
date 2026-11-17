import { scaleTransition } from '@animate-ui/react/utils/motion'
import type { Transition } from 'motion/react'

/* 慢放(只为检查动效:Emil「slow motion testing」——放慢了才看得出落点、回弹对不对)。
   地址里带 ?slowmo=N(1–10)时,概念版的动效按 Animate UI 的 tempo 规则整体放慢 N 倍
   (时长 ×N,弹簧刚度 ÷N²、阻尼 ÷N,形状不变,只是变慢);不带就是 1,正常速度。 */
const n = typeof location === 'undefined' ? 1 : Number(new URLSearchParams(location.search).get('slowmo'))
export const slowmo = n > 1 && n <= 10 ? n : 1
export const slow = <T extends Transition>(t: T): T => (slowmo === 1 ? t : (scaleTransition(t, slowmo) as T))
