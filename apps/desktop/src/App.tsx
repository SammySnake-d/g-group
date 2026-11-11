import { TooltipProvider } from '@/components/ui/tooltip'
import { LAYOUT } from '@/config/layout'
import { ListPane } from '@/app/list/ListPane'
import { Divider } from '@/app/Divider'
import { MainPane } from '@/app/MainPane'
import { Overlays } from '@/app/overlays/Overlays'
import { Rail } from '@/app/Rail'
import { SplitArea } from '@/app/SplitArea'
import { useShell } from '@/app/useShell'
import { rewire } from '@/api/wire'
import { useApp } from '@/store'
import { totals } from '@/store/select'

/* 应用骨架:左侧导航 | 列表栏(可调宽)| 主区(聊天 / 工作台 / 插件 / 文件)| 右侧分栏,浮层盖在上面。
   状态在 src/store(zustand 按领域切片),各区域自己订阅;这里只做组装。 */
export default function App() {
  useShell()
  const { section, panoOpen, helperGlobal, backend, wire, badge, running, listW, setSection, setPanoOpen, setHelperGlobal, push, resize } = useApp((s) => {
    const t = totals(s)
    return { section: s.section, panoOpen: s.panoOpen, helperGlobal: s.helperGlobal, backend: s.backend, wire: s.wire, badge: t.wait + t.err, running: t.run > 0, listW: s.widths.list,
      setSection: s.setSection, setPanoOpen: s.setPanoOpen, setHelperGlobal: s.setHelperGlobal, push: s.push, resize: s.resize }
  })
  return (
    <TooltipProvider delayDuration={500} skipDelayDuration={300}>
      <div className="relative flex h-full min-h-[640px] overflow-hidden bg-bg text-fg">
        <Rail section={section} panoOpen={panoOpen} badge={badge} running={running} helperOpen={helperGlobal} backend={backend} wire={wire} onReload={rewire}
          onSection={setSection} onPano={() => setPanoOpen(true)} onHelper={() => setHelperGlobal(!helperGlobal)} onSettings={() => push({ t: 'settings' }, true)} />
        {section !== 'plugins' && <>
          <ListPane />
          <Divider testid="div-list" label="拖动或按 ←/→ 调整列表宽度" value={listW} min={LAYOUT.list.min} max={LAYOUT.list.max} onDrag={(dx) => resize('list', dx)} />
        </>}
        <MainPane />
        <SplitArea />
        <Overlays />
      </div>
    </TooltipProvider>
  )
}
