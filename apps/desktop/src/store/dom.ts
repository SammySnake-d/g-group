// 状态动作里少数要碰界面的地方(把焦点放回输入框、滚到某条消息)集中在这里,切片里不直接翻 DOM。
/** 当前聊天输入框;Composer 挂上,动作里用它放回焦点 */
export const composerInput: { current: HTMLTextAreaElement | null } = { current: null }

/** 下一拍再聚焦:等草稿、引用条先渲染出来 */
export const focusComposer = () => setTimeout(() => composerInput.current?.focus(), 0)

/** 聊天区的「贴底跟随」:ChatView 挂上;跳到某条旧消息前先松开,免得内容变高时又被拽回底部 */
export const chatFollow: { release: () => void } = { release: () => {} }

export const scrollToMsg = (msgId: string) => {
  chatFollow.release()
  document.getElementById('m-' + msgId)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
}
