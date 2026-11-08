/* Helper 的演示文案与规则数据(原型里的固定剧本):建议条、两条「试试」、CSV 示例、开场白与兜底回复。
   推导逻辑在 answers.ts,界面在 HelperPanel / HelperGlobal。 */

/** 面板里的建议条:点了等于把这句话发给 Helper */
export const CHIPS = ['拉 Claude Code 和 Argon 另开个群聊外部记录接入', '把功能清单 CSV 转成本群清单', '本群谁适合做飞书接入？'] as const

/** 「模拟拖入」用的文件名,以及真拖入但拿不到文件名时的兜底 */
export const DEMO_CSV_NAME = '功能清单.csv'
export const DROPPED_FALLBACK = '拖入的文件'

/** 示例 CSV 的 4 行:每行按关键词去本群分工里找推荐人 */
export const CSV_ROWS: { text: string; keys: string[] }[] = [
  { text: '飞书接入方案', keys: ['需求', '接入'] },
  { text: '设计规范 v1', keys: ['设计规范', '规范'] },
  { text: '插件中心原型', keys: ['原型', '前端'] },
  { text: '定时总览', keys: ['定时', '巡检'] },
]

/** 另开群时默认带的背景消息、没点名时默认拉的人 */
export const GROUP_BG_MSGS = ['g10', 'g11', 'g12']
export const GROUP_DEFAULT_PICKS = ['claude', 'argon']

/** 全局 Helper 的两条「试试」 */
export const READ_ASK = '总结一下前端设计讨论今天说了什么'
export const SEND_ASK = '代我在模型助手群聊说：今晚 10 点前别合并'
/** 「代我在某个群发一句话」填进输入框的开头 */
export const SEND_PREFIX = '代我在模型助手群聊说：'

/** 演示用的「前端设计讨论」:今天的消息条数和总结 */
export const DEMO_DESIGN_CONV = 'g-design'
export const DEMO_DESIGN_COUNT = 12
export const DEMO_DESIGN_SUMMARY =
  '「前端设计讨论」今天说了这些：\n1. Grok 去抓 GrokBot 的设计文章，网页打不开，失败了 3 次，还在等你决定。\n2. Grok 把上海天气答成了广州的数据，Astra 纠正了，Grok 认了。\n3. 状态存储投票：Claude Code 和 Astra 选 SQLite，Grok 选内容寻址文件，等你拍板。'

/* ---------- 面板(只读当前聊天)的话术 ---------- */
export const panelIntro = (title: string) => `我读得到「${title}」的成员和最近的消息。想另拉个群、把表格转成清单，都可以跟我说。`
export const panelFallback = (title: string) => `我只读得到「${title}」。想另拉个群、把表格转成本群清单、或者看看谁适合做某件事，都可以直接说。这里说的话不会发到群里。`
export const PANEL_GROUP_REPLY = '好。原群里什么都不会多，新群建好后我把你选的几条带过去当背景。看一下：'
export const PANEL_CSV_REPLY = '我把表格读成了 4 项，按本群的分工给每项推荐了人。确认后它们进本群的清单（清单属于群），并在群里 @所有人认领。'
export const droppedLine = (name: string) => `（拖进来一个文件：${name}）`
export const DROP_ASK = 'CSV 转成本群清单'

/* ---------- 全局(⌘K)的话术 ---------- */
export const GLOBAL_DRAFT_REPLY = '草稿在这里，你点「发送」我才发：'
export const globalNoGroup = (name: string) => `我没找到「${name}」这个群。你说一下完整的群名？`
export const GLOBAL_IDLE = '我现在没有读取任何聊天。要我看某个群，告诉我群名，我会先问你能不能读；要我代你发消息，我会先给你看草稿。'
export const globalReading = (titles: string[]) => `我现在只读了${titles.map((t) => `「${t}」`).join('')}。要我做什么具体的事，直接说。`
export const globalSummaryOther = (title: string) => `「${title}」最近的讨论我读过了，你想知道哪一块？`
export const GLOBAL_DENIED = '好，不读。没有读到这个群的内容，就没法总结；你想换个问法也可以。'
