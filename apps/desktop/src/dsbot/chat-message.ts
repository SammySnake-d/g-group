import type { ContactView, MessageView, RoomView } from '../../../../packages/api-contract/src/entities.ts'

/** Pure contract projection into the original ChatRows shape. */
export function messageToChatItem(message: MessageView, room: RoomView, userId: string, contacts: readonly ContactView[]) {
  const attachments = message.retracted ? [] : message.attachments.map(file => ({ ...file, id: file.ref }))
  // Failure explanations live in card.body, not just message.text. Never infer
  // failure from a local timeout or discard the backend's original explanation.
  const body = message.retracted ? '消息已撤回' : message.card?.kind === 'failure'
    ? [...new Set([message.text, message.card.title, message.card.body].filter(Boolean))].join('\n\n')
    : message.text
  const common = {
    text: body,
    time: Number.isFinite(Date.parse(message.at)) ? Date.parse(message.at) : 0,
    seq: message.seq, roomId: room.id,
    attachments, files: attachments,
    content: [
      { type: 'text', text: body },
      ...attachments.map(attachment => ({ type: attachment.mime.startsWith('image/') ? 'image' : 'file', attachment })),
    ],
    sender: message.sender,
  }
  if (message.sender.kind === 'user' && message.sender.id === userId) {
    return { ...common, kind: 'user', images: attachments.filter(file => file.mime.startsWith('image/')).length }
  }
  const contact = contacts.find(item => item.id === message.sender.id)
  if (room.kind === 'dm' && message.sender.kind === 'contact') return { ...common, kind: 'bot' }
  return { ...common, kind: 'post', botId: message.sender.id, name: contact?.name ?? (message.sender.kind === 'helper' ? 'Helper' : message.sender.kind === 'system' ? '系统' : message.sender.id) }
}
