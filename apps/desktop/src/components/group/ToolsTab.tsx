/* 群资料·工具：每项写清楚做什么、来自哪里、对应哪条 / 命令，点了直接执行或打开对应页面。
   插件带来的命令点了填进输入框（参数在那边补）；斜杠补全菜单在输入框里做。 */
import type { ReactNode } from 'react'
import { ChevronRight, Puzzle } from 'lucide-react'
import { pluginCommands } from '@g-group/ui-core'
import { useApp } from '@/ctx'
import { artifacts, poolUsed, type Conversation } from '@/data'
import { PluginIcon } from '@/components/plugins/tags'
import { Button } from '@/components/ui/button'
import { BUILTIN_TOOLS, TOOLS, type ToolHow } from './constants'

type ToolRow = { key: string; icon: ReactNode; title: string; cmd: string; desc: string; from?: string; meta?: string; how: ToolHow; run: () => void }

function Row({ t }: { t: ToolRow }) {
  return (
    <Button data-testid={`tool-${t.key}`} variant="ghost" size={null} onClick={t.run}
      className="group h-auto w-full items-start justify-start gap-3 whitespace-normal rounded-xl px-2 py-2 text-left font-normal text-fg active:scale-100">
      {t.icon}
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-[13px] font-medium">{t.title}</span>
          <code data-testid={`tool-cmd-${t.key}`} className="shrink-0 rounded bg-hover px-1 font-code text-[11px] text-fg-2 transition-colors duration-fast group-hover:bg-bg">/{t.cmd}</code>
          {t.meta && <span className="shrink-0 text-[11px] tabular-nums text-fg-3">{t.meta}</span>}
        </span>
        <span className="mt-0.5 block text-[12px] leading-snug text-fg-2">{t.desc}</span>
        {t.from && <span className="mt-0.5 block text-[11px] text-fg-3">{t.from}</span>}
      </span>
      <span className="mt-0.5 flex shrink-0 items-center text-[11.5px] text-fg-3 transition-colors duration-fast group-hover:text-fg">{t.how}<ChevronRight className="h-3.5 w-3.5" /></span>
    </Button>
  )
}

const BuiltinIcon = ({ I }: { I: (typeof BUILTIN_TOOLS)[number]['icon'] }) => (
  <span className="grid h-[30px] w-[30px] shrink-0 place-items-center rounded-lg bg-hover text-fg-2 transition-colors duration-fast group-hover:bg-bg group-hover:text-fg"><I className="h-4 w-4" strokeWidth={1.75} /></span>
)

export function ToolsTab({ conv }: { conv: Conversation }) {
  const { computes, push, commits, playbook, summarize, plugins, putCommand } = useApp()
  const meta: Record<string, string | undefined> = {
    playbook: `${playbook.length} 条`,
    files: `${artifacts.filter((a) => a.conv === conv.id).length} 个`,
    links: conv.links?.length ? `${conv.links.length} 个` : undefined,
    commits: `${commits.filter((c) => c.conv === conv.id && c.on).length} 条`,
    compute: conv.tempCompute ? `${poolUsed(computes, conv.id)}/${conv.tempCompute.max} 在用` : '没开',
  }
  const builtin: ToolRow[] = BUILTIN_TOOLS.map((b) => ({
    key: b.key, icon: <BuiltinIcon I={b.icon} />, title: b.title, cmd: b.cmd, desc: b.desc, how: b.how, meta: meta[b.key],
    run: () => (b.page ? push({ t: b.page, id: conv.id }, true) : summarize(conv.id)),
  }))
  const fromPlugins: ToolRow[] = pluginCommands(plugins, conv.id).map((c) => {
    const m = plugins.find((p) => p.id === c.plugin)!.manifest!
    return { key: `${c.plugin}-${c.command.name}`, icon: <PluginIcon m={m} size={30} />, title: c.command.title, cmd: c.command.name, desc: c.command.desc, from: `来自插件「${c.pluginName}」`, how: '填入输入框', run: () => putCommand(c.command.name) }
  })
  return (
    <section className="px-2 pb-3 pt-1" data-testid="side-tools">
      <div className="px-2 pb-1 pt-1.5 text-[11.5px] font-medium text-fg-3">{TOOLS.builtin}</div>
      {builtin.map((t) => <Row key={t.key} t={t} />)}
      <div className="px-2 pb-1 pt-4 text-[11.5px] font-medium text-fg-3">{TOOLS.fromPlugins}</div>
      {fromPlugins.length ? fromPlugins.map((t) => <Row key={t.key} t={t} />) : <div className="px-2 py-1 text-[12px] text-fg-3">{TOOLS.noPluginCmds}</div>}
      <p className="mx-2 mt-3 flex items-center gap-1 border-t border-line pt-2.5 text-[11.5px] leading-relaxed text-fg-3"><Puzzle className="h-3 w-3" />{TOOLS.foot}</p>
    </section>
  )
}
