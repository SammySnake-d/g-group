/* 分屏和「文件」主面板共用的演示内容:原型里的文档正文、服务器资产、文档冲突演示。
   这些是数据,不是组件;两处预览从这里取,改一处两处一致。 */

/** 「IM 竞品交互对照」开头一句 */
export const ARTICLE_INTRO = '对照了 QQ、Telegram、GrokBot、iMessage 四款产品，看它们怎么处理“谁在做事”和“要你处理什么”。'

/** 第 4 节的初始正文(分屏里可以被文档冲突演示改掉) */
export const ARTICLE_SEC4 = 'Telegram 的机器人按钮贴在输入框上方；iMessage 的快捷回复也在输入区。'

/** 文档四节;第 4 节正文由调用方传入(分屏里会变) */
export const articleSections = (sec4: string): [string, string][] => [
  ['1. 列表', '四家都只给一行预览。需要你处理时只改这一行的颜色，不加徽章。'],
  ['2. 消息', '气泡不描边，连发合并。系统事件只占一行居中灰字。'],
  ['3. 进度在聊天里', '大家都把“谁在干活”放在聊天里，而不是另开页面。'],
  ['4. 决定不混在消息里', sec4],
]

/** 群协作约定(「文件」里除对照文档以外的文档) */
export const PLAYBOOK_INTRO = '群里约定的做事方式，助手每轮都会读。'
export const PLAYBOOK_SECTIONS: [string, string][] = [
  ['分工', '派活请 @ 对应的助手；前端找 Claude Code，性能找 Codex。'],
  ['交接', '做完先换模型复核，再请你验收。'],
  ['要你拍板的事', '助手发一条消息 @你，选项挂在消息下面。'],
]

/** 服务器资产的四行(密码只给引用) */
export const ASSET_ROWS: [string, string][] = [
  ['地址', '43.•••.•••.12'],
  ['用户', 'root'],
  ['密码', '已加密保存，助手只拿到引用，看不到明文'],
  ['部署目录', '/srv/app'],
]
export const ASSET_NOTE_SPLIT = '能用它的助手：Codex、Claude Code · 来自你和 Codex 的私聊 · 删掉原消息不会删掉资产'
export const ASSET_NOTE_FILES = '删掉原消息不会删掉这条资产'

/** 任务板说明 */
export const BOARD_NOTE = '两个人同时领同一项时，先到的领到，后到的会被告知“已被领走”。'

/** AC-21 文档冲突演示:两个助手都基于 v3 改第 4 节 */
export const DOC_DEMO = {
  title: 'IM 竞品交互对照',
  section: '第 4 节',
  claude: '决定贴在提问消息下面：几颗轻按钮，点了以你的名义发一条回复。',
  argon: '决定用消息 + 选项，选项不进输入框上方的托盘。',
} as const

/** 检查点说明 */
export const CHECKPOINT_NOTE = '每做完一步自动存一个检查点。回到某个检查点，之后改的文件会恢复原样；之后的过程记录不删，还能再前进回来。'
