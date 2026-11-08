import { FilesMain } from '@/components/FilesMain'
import { HelperPanel } from '@/components/Helper'
import { PluginCenter } from '@/components/Plugins'
import { Workbench } from '@/components/Workbench'
import { useApp } from '@/store'
import { activeConv } from '@/store/select'
import { ChatView } from './chat/ChatView'
import { Divider } from './Divider'

/** 中间主区:按左侧所在区域换内容——聊天(右边可并排 Helper)/ 联系人工作台 / 插件中心 / 文件 */
export function MainPane() {
  const { section, contact, wbTab, setWbTab, fileSel } = useApp((s) => ({ section: s.section, contact: s.contact, wbTab: s.wbTab, setWbTab: s.setWbTab, fileSel: s.fileSel }))
  if (section === 'contacts') return <Workbench id={contact} tab={wbTab} onTab={setWbTab} />
  if (section === 'plugins') return <PluginCenter />
  if (section === 'files') return <FilesMain id={fileSel} />
  return <><ChatView /><HelperSide /></>
}

/** 聊天里并排的 Helper(只读当前聊天);开着分栏时让给分栏 */
function HelperSide() {
  const { open, width, conv, resize } = useApp((s) => ({ open: s.helperPanel && s.tabs.length === 0, width: s.widths.helper, conv: activeConv(s).id, resize: s.resize }))
  if (!open) return null
  return (
    <>
      <Divider testid="div-helper" onDrag={(dx) => resize('helper', -dx)} />
      <HelperPanel conv={conv} width={width} />
    </>
  )
}
