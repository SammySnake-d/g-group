// 布局尺寸:所有可调宽度的范围和默认值集中在这里,组件只引用常量。
export const LAYOUT = {
  /** 居中阅读栏(消息流 + 输入框)的最大宽度 */
  chatColumn: 860,
  /** 开着分栏时聊天区至少留这么宽 */
  chatMin: 520,
  /** 文件正文与消息链并排的最小窗口宽度；手动开合优先于自动判断。 */
  fileContextMinWidth: 1150,
  list: { min: 220, max: 420, initial: 272 },
  split: { min: 340, max: 720, initial: 440 },
  float: { min: 320, max: 560, initial: 400 },
  helper: { min: 280, max: 520, initial: 340 },
  /** 自己的消息外侧挂着已读回执,悬浮工具条要让开的宽度 */
  receiptReserve: 28,
} as const
