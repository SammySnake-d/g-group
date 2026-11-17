/* 消息模块的对外入口(桶文件)。实现按消息种类和职责拆在 ./messages/ 下:
   列表与编排 MessageList / grouping;一行 Row;悬停工具条 HoverBar;右键菜单 MsgMenu;表情 Reactions;头像菜单 PersonMenu;
   各类消息体 TextBubble / ask(A2UI 提问卡片、你的回答)/ compute / cards(文件、看板、转发、投票、总结、授权、Helper、正在回复)/ lines(日期、系统、讨论、承诺、资产)。
   外部一律从这里 import,不直接引 ./messages/ 里的文件。 */
export { MessageList } from './messages/MessageList'
export { PersonMenu } from './messages/PersonMenu'
export { AskCard as QuickReplies } from './messages/ask/AskCard'
export { ComputeLine } from './messages/compute/ComputeLine'
export { StatusDot, statusText } from './messages/compute/StatusDot'
export { ArtifactIcon } from './messages/cards/Attachments'
export { renderText } from './messages/mentions'
export { Tip } from './messages/Tip'
export { useSelection } from './messages/useSelection'
