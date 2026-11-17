/* 消息菜单(悬停工具条的「更多」、右键菜单)的外观,照 mirasim 的菜单搬(颜色换成我们的 token):
   面板 rounded-lg + 细边 + 浮起阴影 + p-1;每项 min-h-8、px-2 py-1.5、gap-2.5、rounded-md、13px,图标 15px 弱化色,
   高亮项换选中底并把文字和图标各提一档;危险项红字;分隔线 mx-1.5 my-1。
   建议上提为 ui/dropdown-menu、ui/context-menu 的默认样式(回报里写了)。 */
export const MENU_SURFACE = 'rounded-lg border-line bg-elev p-1 shadow-elev'
export const MENU_ITEM = 'min-h-8 gap-2.5 rounded-md px-2 py-1.5 text-[13px] leading-5 text-fg-2 transition-colors duration-fast ease-out focus:bg-sel focus:text-fg data-[highlighted]:bg-sel data-[highlighted]:text-fg [&>svg]:size-[15px] [&>svg]:shrink-0 [&>svg]:text-fg-3 data-[highlighted]:[&>svg]:text-fg-2'
export const MENU_DANGER = 'text-err focus:text-err data-[highlighted]:text-err [&>svg]:text-err data-[highlighted]:[&>svg]:text-err'
export const MENU_SEP = 'mx-1.5 my-1 bg-line'
