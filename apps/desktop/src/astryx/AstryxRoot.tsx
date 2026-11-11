/* Astryx 底座:整棵应用挂在 Astryx 的 Theme 下(neutral 做底 + theme-paper-ink.css 盖成「纸·墨·柿」)。
   亮暗跟随我们自己的 dark 状态,不跟系统。 */
import type { ReactNode } from 'react'
import { Theme } from '@astryxdesign/core/theme'
import { neutralTheme } from '@astryxdesign/theme-neutral/built'
import { useApp } from '@/store'

export function AstryxRoot({ children }: { children: ReactNode }) {
  const dark = useApp((s) => s.dark)
  return <Theme theme={neutralTheme} mode={dark ? 'dark' : 'light'}>{children}</Theme>
}
