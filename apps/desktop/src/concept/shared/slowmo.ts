import { scaleTransition } from '@animate-ui/react/utils/motion'
import type { Transition } from 'motion/react'

const n = typeof location === 'undefined' ? 1 : Number(new URLSearchParams(location.search).get('slowmo'))
export const slowmo = n > 1 && n <= 10 ? n : 1
export const slow = <T extends Transition>(t: T): T => (slowmo === 1 ? t : (scaleTransition(t, slowmo) as T))
