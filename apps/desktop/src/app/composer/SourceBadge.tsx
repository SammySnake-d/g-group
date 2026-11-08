import { parseSource, type SlashSource } from '@g-group/ui-core'
import { Avatar } from '@/components/Avatar'
import { people } from '@/data'
import { findInfo } from '@/pluginInfo'
import { useApp } from '@/store'

const box = 'flex shrink-0 items-center gap-1 rounded-md border border-line px-1.5 py-[1px] text-[11px] text-fg-2'

/** 命令来源标记:内置 / 插件(品牌色字母 + 插件名)/ 助手(头像 + 名字) */
export function SourceBadge({ src }: { src: SlashSource }) {
  const plugins = useApp((s) => s.plugins)
  const s = parseSource(src)
  if (!s || s.kind === 'builtin') return <span data-testid="slash-src" className="shrink-0 px-1.5 text-[11px] text-fg-3">内置</span>
  if (s.kind === 'plugin') {
    const p = findInfo(plugins, s.id)
    return (
      <span data-testid="slash-src" className={box}>
        <span className="grid h-3.5 w-3.5 place-items-center rounded-[4px] text-[8.5px] font-semibold leading-none text-white" style={{ background: p?.color }}>{p?.letter}</span>
        插件 · {p?.name ?? s.id}
      </span>
    )
  }
  return (
    <span data-testid="slash-src" className={box}>
      <Avatar id={s.id} size={14} status={false} mood="idle" />
      助手 · {people[s.id]?.name ?? s.id}
    </span>
  )
}
