/* 插件中心的文案与常量:界面上的说法集中在这里,组件只引用。 */
import { Compass, Package, RefreshCw, type LucideIcon } from 'lucide-react'
import type { MarketSort, RiskLevel } from '@g-group/ui-core'

export type PluginTab = 'discover' | 'installed' | 'updates'

export const TABS: { k: PluginTab; label: string; icon: LucideIcon; badge?: boolean }[] = [
  { k: 'discover', label: '发现', icon: Compass },
  { k: 'installed', label: '已安装', icon: Package },
  { k: 'updates', label: '有更新', icon: RefreshCw, badge: true },
]
export const TAB_LABEL: Record<PluginTab, string> = { discover: '发现', installed: '已安装', updates: '有更新' }

export const SORT_OPTIONS: { value: MarketSort; label: string }[] = [
  { value: 'featured', label: '精选顺序' },
  { value: 'name', label: '按名称' },
  { value: 'updated', label: '最近更新' },
]

/** 风险级别 → Chip 色调(颜色之外永远带「x风险」文字) */
export const RISK_TONE: Record<RiskLevel, 'ok' | 'warm' | 'err'> = { low: 'ok', medium: 'warm', high: 'err' }

/** 官方发布者:名字前加认证标 */
export const OFFICIAL_PUBLISHER = 'g-group 官方'

export const COPY = {
  centerTitle: '插件',
  centerDesc: '给助手加本事。装了要挂到聊天才生效。',
  categories: '类别',
  allCategories: '全部',
  sideloadTitle: '从文件或地址安装',
  sideloadHint: '粘贴 plugin.json 或 https 地址',
  demoNote: '现在是演示数据：市场里的安装只改本机界面状态，接上后端才会真的下载。',
  discoverTitle: '发现插件',
  discoverDesc: '取消息、发邮件、多一块面板、多一条 / 命令。装之前会逐条告诉你它要什么权限。',
  searchPlaceholder: '搜名称、简介或命令，比如 /mail',
  installedTitle: '已安装',
  installedDesc: '停用后所有聊天里都暂时用不了；卸载会从聊天上摘下并收回权限。装了但没挂到聊天的，不生效。',
  installedEmpty: '还没装插件。',
  updatesTitle: '有更新',
  updatesDesc: '更新不会改你挂的聊天和调用名单。新版本多要的权限，会先问你。',
  updatesEmpty: '都是最新版本。',
  untrusted: '取来的内容一律标「不可信外部数据」：只当背景参考，不会让助手自动开工，也不能触发控制指令或授权。',
  untrustedHow: '在聊天里从输入框的「+」选数据源，取来的内容挂到输入框上方的引用条，你看过再发。',
  outbound: '助手只能在「外发预授权」说好的范围里发：给哪项承诺用、用哪个账号、发给谁、能用哪些数据、发什么、每小时几次。每次发之前都会复核；授权失效或你撤销，外发立即停下，群里出修复卡。',
  whereEmpty: '装好以后，在这里选挂到哪些聊天、哪些助手能调用。装了不挂不生效。',
  whereRule: '已启用、挂到这个聊天、助手在名单里，三样都满足它才用得上。',
  sideloadDesc: '粘贴插件清单（plugin.json）或它的 https 地址，也可以选一个本地 .json 文件。清单先在本机校验；下载安装包、核对签名要连接后端。',
  sideloadPlaceholder: '{\n  "id": "acme.notes",\n  "name": "笔记",\n  "version": "0.1.0",\n  …\n}\n或 https://plugins.example.com/notes/plugin.json',
  sideloadNeedBackend: '安装包要从发布者那里下载并核对签名，这一步需要连接后端。现在没连上，所以还没有安装。',
  sideloadUrlBackend: '从地址取清单和安装包需要连接后端，现在没连上，所以还没去取，也没有安装。',
  attachDesc: '装好还不生效：挂到哪个聊天、让哪些助手能调用，那里才用得上。也可以以后在群资料·插件里挂。',
  uninstallDesc: '卸载后要用得重新安装、重新同意权限。',
} as const

/** 连着后端时的说法:宿主里装好的插件对所有聊天生效,后端不分会话挂载、没有调用者名单;外发预授权后端没有这一项;
 *  插件市场目录按用户决定暂不接,从文件或地址安装也还没接。关着的原因写在界面上,不藏在提示里 */
export const COPY_LIVE = {
  centerDesc: '给助手加本事。装好的插件对所有聊天生效。',
  liveNote: '已连上后端：「已安装」读的是这台电脑上真实装好的插件。插件市场、从文件或地址安装还没接上。',
  marketOff: '插件市场还没接上后端：这里只列得出已经装好的插件，看不到市场里可以装的。',
  installedDesc: '装好的插件对所有聊天生效；停用后所有聊天里都暂时用不了；卸载会收回权限。',
  installedEmpty: '这台电脑上还没装插件。插件市场还没接上后端，现在在这里装不了。',
  rowWhere: '对所有聊天生效',
  updatesDesc: '新版本多要的权限，会先问你。',
  where: '插件对所有聊天生效，后端不分会话挂载。',
  whereHow: '所以这里不能挂到某个聊天、从某个聊天摘下，也不能限定哪些助手能调用。想让它暂时用不了，用上面的「启用」开关，对所有聊天生效。',
  grantOff: '后端没有外发预授权这一项',
  grantWhy: '插件的配置（plugins.configure）只存它自己的设置；外发之前后端不核对给哪项承诺用、发给谁、发什么、每小时几次，也不会告诉界面授权有没有失效。所以这里不能设置授权。',
  outbound: '后端现在没有外发预授权：外发之前不核对给哪项承诺用、发给谁、发什么、每小时几次。',
  uninstallAll: '所有聊天里都不能再用它',
  sideloadDesc: '粘贴插件清单（plugin.json）或它的 https 地址，也可以选一个本地 .json 文件。清单先在本机校验；安装这一步还没接上后端。',
  sideloadOff: '从文件或地址安装还没接上后端，所以没有安装。',
  sideloadInstall: '安装（还没接上后端）',
} as const

/** 外发预授权表单的空白初值里默认勾上的数据源 */
export const GRANT_DEFAULT_SOURCE = '本群消息'
