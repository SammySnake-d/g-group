// 状态动作里少数要碰界面的地方(把焦点放回输入框、滚到某条消息)集中在这里,切片里不直接翻 DOM。
export const composerInput: { current: HTMLTextAreaElement | null } = { current: null }

export const focusComposer = () => setTimeout(() => composerInput.current?.focus(), 0)

export const chatFollow: { release: () => void } = { release: () => {} }

export const scrollToMsg = (msgId: string) => {
  chatFollow.release()
  document.getElementById('m-' + msgId)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
}
