import { useState } from 'react'
import { Puzzle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useApp } from '@/ctx'
import { Avatar } from '@/components/Avatar'
import { GlobalModelDefaults } from '@/components/ModelSettings'
import { Surface } from '@/components/ui/surface'
import { Switch } from '@astryxdesign/core/Switch'
import { ListGroup, ListRow } from '@/components/ui/list-row'
import { Choice, ChoiceGroup } from './kit/choice'
import { Hint, PageScroll } from './kit/parts'
import { THEMES } from './constants'

/* ---------- 设置:账号 → 外观 → 默认模型 → 通知 → 插件 → 连接 → 高级 ---------- */
export function SettingsPage() {
  const { dark, setDark, debug, setDebug, push, setSection, closeAll } = useApp()
  // 保持原页面的临时通知偏好语义；这次只迁移控件，不扩展持久化/后端契约。
  const [waitingNotice, setWaitingNotice] = useState(true)
  const [errorNotice, setErrorNotice] = useState(true)
  const switchTheme = '[--color-accent:hsl(var(--me))] [--color-on-accent:hsl(var(--bg))]'
  return (
    <PageScroll>
      <Surface elevation="sunken" className="mx-3 mb-3 flex items-center gap-3 p-3">
        <Avatar id="me" size={44} />
        <div className="min-w-0 flex-1"><div className="truncate text-[15px] font-semibold">39impacts</div><div className="text-[12.5px] tabular-nums text-fg-2">本月共花费 ¥85.30</div></div>
      </Surface>
      <ListGroup title="外观">
        <ChoiceGroup label="外观" value={dark ? 'dark' : 'light'} onChange={(v) => setDark(v === 'dark')} className="flex gap-2 p-3">
          {THEMES.map((o) => (
            <Choice key={o.label} value={o.dark ? 'dark' : 'light'} label={o.label}
              className={cn('flex-1 rounded-lg border p-2 text-[13px] text-fg-2 hover:border-fg-3/50', 'data-[state=on]:border-fg data-[state=on]:bg-bg data-[state=on]:font-medium data-[state=on]:text-fg', 'border-line')}>
              <div aria-hidden className={cn('mb-1.5 flex h-10 items-end gap-1 rounded-md p-1.5', o.paper)}>
                <span className={cn('h-2 w-8 rounded-full', o.ink)} /><span className={cn('h-2 w-4 rounded-full', o.ink)} />
              </div>
              {o.label}
            </Choice>
          ))}
        </ChoiceGroup>
      </ListGroup>
      <GlobalModelDefaults />
      <ListGroup title="通知">
        <ListRow label="有事等我时提醒"><Switch label="有事等我时提醒" isLabelHidden size="sm" className={switchTheme} value={waitingNotice} onChange={setWaitingNotice} /></ListRow>
        <ListRow label="出错时提醒"><Switch label="出错时提醒" isLabelHidden size="sm" className={switchTheme} value={errorNotice} onChange={setErrorNotice} /></ListRow>
      </ListGroup>
      <ListGroup title="插件">
        <ListRow testid="settings-plugins" label={<span className="flex items-center gap-2"><Puzzle className="h-4 w-4 shrink-0 text-fg-2" />插件中心</span>} value="市场、安装、更新" onClick={() => { setSection('plugins'); closeAll() }} />
      </ListGroup>
      <ListGroup title="连接">
        <ListRow label="外部来源" value="已连 2 个" onClick={() => push({ t: 'sources' })} />
        <ListRow label="模型服务" value="3 个" onClick={() => {}} />
      </ListGroup>
      <ListGroup title="高级"><ListRow label="调试模式"><Switch label="调试模式" isLabelHidden size="sm" className={switchTheme} value={debug} onChange={setDebug} /></ListRow></ListGroup>
      <Hint className="px-6 text-[12px]">调试模式会在 Compute 里显示内部编号等排查信息，平时不需要打开。</Hint>
    </PageScroll>
  )
}
