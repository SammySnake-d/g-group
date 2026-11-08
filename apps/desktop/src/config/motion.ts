// 动效规范(Emil Kowalski / Vercel Web Interface Guidelines):进场 ease-out、时长 <300ms、
// 只动 transform / opacity、可被打断、尊重 prefers-reduced-motion。CSS 侧对应 index.css 的 --ease-out / --dur-*。
export const EASE_OUT = [0.23, 1, 0.32, 1] as const
export const DUR = { fast: 0.12, base: 0.18, slow: 0.24 } as const
/** 折叠/展开:高度 + 透明度一起走,退场比进场快 */
export const collapse = {
  initial: { height: 0, opacity: 0 },
  animate: { height: 'auto', opacity: 1, transition: { duration: DUR.base, ease: EASE_OUT } },
  exit: { height: 0, opacity: 0, transition: { duration: DUR.fast, ease: EASE_OUT } },
} as const
/** 浮起的小控件(回到最新、有人 @ 你):从下方 6px 淡入 */
export const rise = {
  initial: { opacity: 0, y: 6, scale: 0.98 },
  animate: { opacity: 1, y: 0, scale: 1, transition: { duration: DUR.base, ease: EASE_OUT } },
  exit: { opacity: 0, y: 4, scale: 0.98, transition: { duration: DUR.fast, ease: EASE_OUT } },
} as const
