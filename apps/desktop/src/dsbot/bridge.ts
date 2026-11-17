/**
 * g-group 的 DS-Bot 窗口数据口。
 * 原版视图不认识 g-group 的联系人/私聊双 ID；映射只在这里发生，不引入 DSH 后端。
 * UI-only 偏好存在 g-group.ds-bot.presentation.v1，业务与令牌仍由原有宿主持有。
 */
import { API_VERSION } from '../../../../packages/api-contract/src/api.ts'
import type { ContactView, MessageView, RoomView, SettingsView } from '../../../../packages/api-contract/src/entities.ts'
import type { ServerEvent } from '../../../../packages/api-contract/src/events.ts'
import type { SetupView } from '../api/app-shell-types.ts'
import { mentionSpans } from '../dsbot-base/upstream/ds-bot/src/shared/mentions.js'
import { messageToChatItem } from './chat-message.ts'

type Body = Record<string, unknown>
type Result = { ok: true; value: unknown } | { ok: false; error: { code?: string; message: string } | string }
type Listener = (event: string, data: Body) => void
export interface DsBotTransport {
  invoke(method: string, params: Body): Promise<Result>
  subscribe(listener: (event: ServerEvent) => void, options?: { sinceEventSeq?: number }): () => void
  shell?(method: string, params: Body): Promise<Result>
  storage?: Pick<Storage, 'getItem' | 'setItem'>
  actionId?: () => string
}
interface Presentation {
  prefs?: Body
  looks?: Record<string, { color?: unknown; avatar?: unknown }>
  flags?: Record<string, Body>
}
const PRESENTATION_KEY = ['g-group', 'ds-bot', 'presentation', 'v1'].join('.')
const text = (value: unknown) => typeof value === 'string' ? value : ''
const at = (value: string) => Number.isFinite(Date.parse(value)) ? Date.parse(value) : 0
const refused = (message: string, code = 'bot/refused'): never => { throw Object.assign(new Error(message), { code }) }
const abortIfNeeded = (signal?: AbortSignal) => { if (signal?.aborted) throw new DOMException('请求已取消', 'AbortError') }
const record = (value: unknown): Body => value && typeof value === 'object' && !Array.isArray(value) ? value as Body : {}

export function createDsBotBridge(transport: DsBotTransport) {
  let userId = ''
  let eventSeq = 0
  let contacts: ContactView[] = []
  let rooms: RoomView[] = []
  let settings: SettingsView | null = null
  let revision = 0
  let lastState = ''
  let helloPromise: Promise<void> | null = null
  const activeRoomByContact = new Map<string, string | null>()
  const listeners = new Set<Listener>()
  const actionId = transport.actionId ?? (() => `dsbot-${crypto.randomUUID()}`)
  const emit = (event: string, data: Body = {}) => { for (const fn of listeners) fn(event, data) }
  const presentation = (): Presentation => {
    try { return JSON.parse(transport.storage?.getItem(PRESENTATION_KEY) ?? '{}') as Presentation } catch { return {} }
  }
  let local = presentation()
  const persist = (next: Presentation) => {
    // 保存失败必须原样告知，不能显示“已保存”却在重启后丢失。
    if (!transport.storage) return refused('当前环境不能保存界面偏好')
    transport.storage.setItem(PRESENTATION_KEY, JSON.stringify(next))
    local = next
    revision += 1
    emit('revision', { revision })
  }
  const invoke = async (method: string, params: Body = {}, signal?: AbortSignal) => {
    abortIfNeeded(signal)
    const result = await transport.invoke(method, params)
    if (!result.ok) {
      const error = typeof result.error === 'string' ? { message: result.error } : result.error
      return refused(error.message, error.code ?? 'bot/refused')
    }
    return result.value
  }
  const shell = async (method: string, params: Body = {}) => {
    if (!transport.shell) return refused('请在 g-group 桌面应用里配置模型网关')
    const result = await transport.shell(method, params)
    if (!result.ok) return refused(typeof result.error === 'string' ? result.error : result.error.message)
    return result.value
  }
  const setup = async (): Promise<SetupView | null> => transport.shell ? await shell('setup.get') as SetupView : null
  const hello = () => helloPromise ??= invoke('session.hello', { clientApiVersion: API_VERSION }).then(value => {
    const info = record(value)
    if (text(info.apiVersion).split('.')[0] !== API_VERSION.split('.')[0]) refused('前后端接口版本不一致，请更新 g-group')
    userId = text(info.userId)
    eventSeq = Number(info.eventSeq) || 0
  }).catch(error => { helloPromise = null; throw error })
  const reload = async () => {
    await hello()
    const [people, list, configuration] = await Promise.all([
      invoke('contacts.list'), invoke('rooms.list'), invoke('settings.get'),
    ])
    contacts = (people as { contacts: ContactView[] }).contacts
    rooms = (list as { rooms: RoomView[] }).rooms
    settings = configuration as SettingsView
  }
  const contactForDm = (room: RoomView) => room.members.find(member => member.kind === 'contact')?.id
  const uiSessionId = (room: RoomView) => room.kind === 'dm' ? contactForDm(room) ?? room.id : room.id
  const botView = (contact: ContactView) => ({
    id: contact.id, sessionId: contact.id, parts: [], name: contact.name, role: contact.bio,
    model: contact.speakingModel, createdAt: at(contact.createdAt), waiting: !contact.speakingModel,
    ...(local.looks?.[contact.id] ?? {}),
    ...(contact.avatar ? { avatar: { ...record(local.looks?.[contact.id]?.avatar), image: contact.avatar } } : {}),
    ...(local.flags?.[contact.id] ?? {}),
  })
  const roomView = (room: RoomView) => ({
    id: room.id, sessionId: room.id, name: room.title, members: room.members.filter(member => member.kind === 'contact').map(member => member.id),
    // g-group 无 DS-Bot admin；不把“第一位成员”虚构成管理者。
    createdAt: at(room.updatedAt), updatedAt: at(room.updatedAt), pinned: room.pinned,
    description: room.rules, purpose: room.rules, mode: 'everyone', hidden: false,
    preview: room.lastMessagePreview ?? '',
    ...(local.flags?.[room.id] ?? {}),
  })
  const modelViews = (gatewayModel = '') => {
    const models = new Map((settings?.models ?? []).map(model => [model.id, { id: model.id, ref: model.id, name: model.label || model.id, provider: 'g-group-gateway', providerName: model.vendor || '模型网关', needsKey: false }]))
    for (const id of [gatewayModel, settings?.defaultSpeakingModel ?? '', ...contacts.map(contact => contact.speakingModel)].filter(Boolean)) {
      if (!models.has(id)) models.set(id, { id, ref: id, name: id, provider: 'g-group-gateway', providerName: '模型网关', needsKey: false })
    }
    return [...models.values()]
  }
  const state = async () => {
    const installation = await setup()
    const ready = !installation || installation.backend.state === 'running'
    if (ready) await reload()
    else { contacts = []; rooms = []; settings = null }
    const models = modelViews(installation?.gateway?.model)
    const bots = contacts.map((contact, index) => ({
      ...botView(contact),
      ...(index === 0 && !contact.avatar && !local.looks?.[contact.id] ? { avatar: { shape: 'ring' }, color: 'blue' } : {}),
    }))
    const groupRooms = rooms.filter(room => room.kind === 'group').map(roomView)
    const workBots: Record<string, Body> = {}
    const workRooms: Record<string, Body[]> = {}
    const activity: Record<string, string> = {}
    for (const contact of contacts) {
      if (contact.activity === 'idle' || contact.activity === 'offline') continue
      activity[contact.id] = contact.activity === 'thinking' ? 'thinking' : contact.activity === 'replying' ? 'sending' : 'working'
      const activeRoomId = activeRoomByContact.get(contact.id)
      const inGroup = activeRoomId && rooms.some(room => room.id === activeRoomId && room.kind === 'group')
      workBots[contact.id] = { botId: contact.id, ...(inGroup ? { roomId: activeRoomId } : {}) }
      if (inGroup) (workRooms[activeRoomId] ??= []).push({ botId: contact.id })
    }
    const value = {
      // 主卡只是第一位真实联系人的视觉位置，不授予“总管”权限。
      mainBotId: bots[0]?.id ?? null, mainBotIds: [], bots, rooms: groupRooms,
      agents: [], sections: [], exchangeTurns: {}, questions: {}, btwCards: {}, sideChats: {}, learning: {},
      secrets: [], capabilities: [], capabilityStatuses: {}, phone: null, secretRequests: {}, connectors: [],
      models, defaultModel: settings?.defaultSpeakingModel || installation?.gateway?.model || null,
      modelsKey: JSON.stringify(models),
      prefs: { layout: 'bubble', enterToSend: true, ...local.prefs },
      work: { bots: workBots, rooms: workRooms, approvals: [] }, activity, memoryNews: {},
      setupRequired: !ready,
    }
    const serialized = JSON.stringify(value)
    if (serialized !== lastState) { revision += 1; lastState = serialized }
    return { ...value, revision }
  }
  const resolveRoom = async (id: string): Promise<RoomView> => {
    if (!contacts.length && !rooms.length) await reload()
    const group = rooms.find(room => room.id === id)
    if (group) return group
    if (!contacts.some(contact => contact.id === id)) return refused('联系人或会话不存在', 'bot/not-found')
    const existing = rooms.find(room => room.kind === 'dm' && contactForDm(room) === id)
    if (existing) return existing
    const opened = await invoke('rooms.openDm', { contactId: id }) as RoomView
    rooms = [...rooms.filter(room => room.id !== opened.id), opened]
    return opened
  }
  const providers = async () => {
    const installation = await setup()
    const gateway = installation?.gateway
    return {
      available: Boolean(transport.shell), protocols: ['anthropic-messages'], addable: [],
      providers: gateway ? [{
        id: 'g-group-gateway', name: '模型网关', key: { configured: gateway.hasToken, writable: true }, removable: false,
        models: modelViews(gateway.model), baseURL: gateway.baseUrl,
      }] : [],
    }
  }
  const localFlags = (id: string, patch: Body) => {
    persist({ ...local, flags: { ...local.flags, [id]: { ...local.flags?.[id], ...patch } } })
  }
  const updateBot = async (payload: Body) => {
    const id = text(payload.id)
    const allowed = new Set(['id', 'name', 'role', 'brief', 'model', 'avatar', 'color', 'hidden', 'pinned', 'sectionId'])
    if (Object.keys(payload).some(key => !allowed.has(key))) return refused('这项 DS-Bot 联系人设置尚未接入 g-group')
    const patch: Body = { contactId: id }
    if (payload.name !== undefined) patch.name = payload.name
    if (payload.role !== undefined || payload.brief !== undefined) patch.bio = text(payload.role ?? payload.brief)
    if (payload.model !== undefined) patch.speakingModel = payload.model
    const avatar = record(payload.avatar)
    if (avatar.image !== undefined) patch.avatar = avatar.image
    if (Object.keys(patch).length > 1) await invoke('contacts.update', patch)
    if (payload.color !== undefined || payload.avatar !== undefined) {
      persist({ ...local, looks: { ...local.looks, [id]: { ...local.looks?.[id], ...(payload.color !== undefined ? { color: payload.color } : {}), ...(payload.avatar !== undefined ? { avatar: payload.avatar } : {}) } } })
    }
    if (payload.hidden !== undefined || payload.pinned !== undefined || payload.sectionId !== undefined) {
      localFlags(id, Object.fromEntries(['hidden', 'pinned', 'sectionId'].filter(key => payload[key] !== undefined).map(key => [key, payload[key]])))
    }
    await reload()
    const contact = contacts.find(item => item.id === id)
    return contact ? botView(contact) : refused('联系人不存在', 'bot/not-found')
  }

  const call = async (endpoint: string, raw: unknown = {}, signal?: AbortSignal): Promise<unknown> => {
    abortIfNeeded(signal)
    const payload = record(raw)
    switch (endpoint) {
      case 'state': return state()
      case 'chat':
      case 'earlier': {
        const room = await resolveRoom(text(payload.botId ?? payload.sessionId ?? payload.roomId))
        const cursor = record(payload.cursor)
        const beforeSeq = Number(cursor.beforeSeq ?? payload.cursor)
        const page = await invoke('messages.list', { roomId: room.id, limit: 100, ...(Number.isInteger(beforeSeq) && beforeSeq > 0 ? { beforeSeq } : {}) }, signal) as { messages: MessageView[]; hasMore: boolean }
        const ordered = [...page.messages].sort((a, b) => a.seq - b.seq)
        return { sessionId: uiSessionId(room), items: ordered.map(message => messageToChatItem(message, room, userId, contacts)), cursor: page.hasMore && ordered.length ? { beforeSeq: ordered[0].seq } : null, btw: [], startedAt: null }
      }
      case 'send': {
        const room = await resolveRoom(text(payload.sessionId ?? payload.roomId))
        const attachmentRefs = Array.isArray(payload.attachments) ? payload.attachments.map(value => typeof value === 'string' ? value : text(record(value).ref)) : []
        // DS-Bot's server parsed @Name. g-group's contract takes recipient IDs;
        // use the very same literal/code/path exclusions as the original bubbles.
        const members = contacts.filter(contact => room.members.some(member => member.kind === 'contact' && member.id === contact.id))
        const spans = room.kind === 'group' ? mentionSpans(text(payload.text), members) : []
        const mentioned = [...new Set(spans.flatMap(span => span.all ? members.map(member => member.id) : span.bot ? [span.bot.id] : []))]
        const message = await invoke('messages.send', { roomId: room.id, clientActionId: text(payload.clientActionId) || actionId(), text: text(payload.text), ...(attachmentRefs.length ? { attachments: attachmentRefs } : {}), ...(mentioned.length ? { mentions: mentioned.map(id => ({ id, source: 'auto' })) } : {}) }, signal) as MessageView
        // 持久化结果是准绳；原版 pending row 靠 feed 清理。真实事件重放由 ChatRows 去重。
        emit('message', { botId: uiSessionId(room), sessionId: uiSessionId(room), item: messageToChatItem(message, room, userId, contacts) })
        return message
      }
      case 'create-bot': {
        const created = await invoke('contacts.create', { clientActionId: actionId(), name: text(payload.name), ...(payload.model ? { speakingModel: text(payload.model) } : {}), ...(payload.brief ? { bio: text(payload.brief) } : {}) }, signal) as ContactView
        contacts = [...contacts, created]
        if (payload.avatar !== undefined || payload.color !== undefined) {
          persist({ ...local, looks: { ...local.looks, [created.id]: { avatar: payload.avatar, color: payload.color } } })
          const image = record(payload.avatar).image
          if (typeof image === 'string') await invoke('contacts.update', { contactId: created.id, avatar: image })
        }
        return botView(created)
      }
      case 'update-bot': return updateBot(payload)
      case 'delete-bot': return invoke('contacts.remove', { contactId: text(payload.id) }, signal)
      case 'create-room': {
        if (!contacts.length) await reload()
        const members = [...new Set((Array.isArray(payload.members) ? payload.members : []).map(text).filter(Boolean))]
        const names = members.map(id => contacts.find(contact => contact.id === id)?.name ?? id)
        const created = await invoke('rooms.createGroup', { clientActionId: actionId(), title: text(payload.name ?? payload.title) || names.join('、').slice(0, 200) || '新群聊', members: members.map(id => ({ kind: 'contact', id })) }, signal) as RoomView
        rooms = [...rooms.filter(room => room.id !== created.id), created]
        return roomView(created)
      }
      case 'update-room': {
        const allowed = new Set(['id', 'name', 'title', 'description', 'purpose', 'members', 'pinned', 'muted'])
        if (Object.keys(payload).some(key => !allowed.has(key))) return refused('这项 DS-Bot 群设置尚未接入 g-group')
        const id = text(payload.id)
        const current = await resolveRoom(id)
        const patch: Body = { roomId: id }
        if (payload.name !== undefined || payload.title !== undefined) patch.title = payload.name ?? payload.title
        if (payload.description !== undefined || payload.purpose !== undefined) { patch.rules = payload.description ?? payload.purpose; patch.expectedRulesVersion = current.rulesVersion }
        if (payload.pinned !== undefined) patch.pinned = payload.pinned
        if (payload.muted !== undefined) patch.muted = payload.muted
        if (payload.members !== undefined) return refused('群成员增删尚未接入，请勿将未保存显示为成功')
        return roomView(await invoke('rooms.update', patch, signal) as RoomView)
      }
      case 'delete-room': return invoke('rooms.dissolve', { roomId: text(payload.id) }, signal)
      case 'set-flags': {
        const id = text(payload.id)
        const patch = Object.fromEntries(Object.entries(payload).filter(([key]) => key !== 'id'))
        if (Object.keys(patch).some(key => !['hidden', 'pinned', 'sectionId'].includes(key))) return refused('这项列表设置尚未接入')
        if (patch.pinned !== undefined && rooms.some(room => room.id === id)) await invoke('rooms.update', { roomId: id, pinned: patch.pinned }, signal)
        localFlags(id, patch)
        return { ok: true }
      }
      case 'set-prefs': {
        const allowed = new Set(['layout', 'sendsOnEnter', 'enterToSend', 'width', 'flatWidth', 'theme', 'accent', 'motion', 'thinking', 'defaultBotModel', 'lang', 'sidebar'])
        if (Object.keys(payload).some(key => !allowed.has(key))) return refused('这项 DS-Bot 偏好尚未接入 g-group')
        if (payload.defaultBotModel !== undefined && payload.defaultBotModel !== null) await invoke('settings.update', { defaultSpeakingModel: text(payload.defaultBotModel) }, signal)
        persist({ ...local, prefs: { ...local.prefs, ...payload } }); return { ok: true }
      }
      case 'models': await reload(); return modelViews()
      case 'providers': return providers()
      case 'provider-models': {
        if (payload.api && payload.api !== 'anthropic-messages') return refused('当前 g-group 后端只接入 Anthropic Messages 协议，其他协议尚未接入')
        const view = await shell('setup.models', { baseUrl: text(payload.baseURL), ...(text(payload.key) ? { token: text(payload.key) } : {}) }) as { models: { id: string; label: string }[] }
        return view.models.map(model => ({ id: model.id, name: model.label }))
      }
      case 'provider-add': {
        if (!payload.custom) return refused('请使用“自定义 API”配置现有 g-group 网关')
        if (payload.api !== 'anthropic-messages') return refused('当前 g-group 后端只接入 Anthropic Messages 协议')
        const models = Array.isArray(payload.models) ? payload.models : []
        const model = text(record(models[0]).id)
        if (!model) return refused('请先选择或填写模型 ID')
        await shell('setup.save', { baseUrl: text(payload.baseURL), model, ...(text(payload.key) ? { token: text(payload.key) } : {}) })
        restartFeed()
        return providers()
      }
      case 'provider-key': {
        const installation = await setup()
        if (!installation?.gateway) return refused('请先添加模型网关')
        if (!text(payload.value)) return refused('当前应用不能单独清除网关令牌；请在接入设置中替换')
        await shell('setup.save', { baseUrl: installation.gateway.baseUrl, model: installation.gateway.model, token: text(payload.value) })
        restartFeed()
        return providers()
      }
      case 'attachment-upload':
      case 'attachments.upload': return invoke('attachments.upload', { name: text(payload.name), base64: text(payload.base64) }, signal)
      case 'file-read':
      case 'open-file': return invoke('files.read', { ref: text(payload.ref ?? payload.file), maxBytes: 16 * 1024 * 1024 }, signal)
      case 'file-text': {
        const file = await invoke('files.read', { ref: text(payload.file ?? payload.ref), maxBytes: 16 * 1024 * 1024 }, signal) as { encoding: string; content: string }
        return file.encoding === 'text' ? file.content : refused('这个文件不是可直接阅读的文本')
      }
      case 'group-rows': return { rows: [], open: false, active: false }
      case 'room-progress':
      case 'exchange':
      case 'schedules': return []
      case 'avatar-library': return { items: [], cursor: null }
      case 'run-stats': return null
      case 'efforts': return []
      case 'folders': return { folders: [], current: null }
      case 'repo-stars': return null
      case 'diagnostics': return { available: false, reason: 'g-group 不提供 DSH 诊断接口' }
      default: return refused(`“${endpoint}”尚未接入 g-group；没有执行或保存`)
    }
  }

  const onServerEvent = async (event: ServerEvent) => {
    eventSeq = Math.max(eventSeq, event.eventSeq)
    if (event.type === 'message.appended' || event.type === 'message.updated') {
      let room = rooms.find(item => item.id === event.message.roomId)
      if (!room) { await reload(); room = rooms.find(item => item.id === event.message.roomId) }
      if (!room) return
      if (event.type === 'message.updated') emit('hello', { eventSeq })
      else emit('message', { botId: uiSessionId(room), sessionId: uiSessionId(room), item: messageToChatItem(event.message, room, userId, contacts) })
    } else if (event.type === 'contact.updated') {
      contacts = [...contacts.filter(item => item.id !== event.contact.id), event.contact]
    } else if (event.type === 'contact.removed') {
      contacts = contacts.filter(item => item.id !== event.contactId)
    } else if (event.type === 'room.updated') {
      rooms = [...rooms.filter(item => item.id !== event.room.id), event.room]
    } else if (event.type === 'room.removed') {
      rooms = rooms.filter(item => item.id !== event.roomId)
    } else if (event.type === 'contact.activity') {
      activeRoomByContact.set(event.contactId, event.roomId)
      contacts = contacts.map(contact => contact.id === event.contactId ? { ...contact, activity: event.activity } : contact)
    } else if (event.type === 'stream.resync') emit('hello', { eventSeq })
    revision += 1
    emit('revision', { revision })
  }
  let feedEpoch = 0
  let connecting = false
  let unsubscribe: (() => void) | undefined
  let retry: ReturnType<typeof setTimeout> | undefined
  const disconnectFeed = () => {
    feedEpoch += 1
    unsubscribe?.(); unsubscribe = undefined
    if (retry) clearTimeout(retry)
    retry = undefined
    connecting = false
  }
  const connectFeed = () => {
    if (!listeners.size || connecting || unsubscribe) return
    const epoch = feedEpoch
    connecting = true
    // 先握手再从该游标续订，避免在读取名册期间漏掉消息。
    void hello().then(() => {
      if (epoch !== feedEpoch || !listeners.size) return
      unsubscribe = transport.subscribe(event => { void onServerEvent(event).catch(error => emit('lost', { message: error instanceof Error ? error.message : String(error) })) }, { sinceEventSeq: eventSeq })
      emit('hello', { eventSeq })
    }).catch(error => {
      if (epoch !== feedEpoch || !listeners.size) return
      emit('lost', { message: error instanceof Error ? error.message : String(error) })
      // A new installation has no backend until setup.save. Do not leave its
      // feed permanently disconnected just because that first handshake failed.
      retry = setTimeout(() => { retry = undefined; connectFeed() }, 1000)
    }).finally(() => { if (epoch === feedEpoch) connecting = false })
  }
  const restartFeed = () => { disconnectFeed(); helloPromise = null; connectFeed() }
  const openFeed = (onEvent: Listener) => {
    listeners.add(onEvent)
    connectFeed()
    return () => { listeners.delete(onEvent); if (!listeners.size) disconnectFeed() }
  }
  return { call, openFeed }
}

const browserTransport: DsBotTransport = {
  async invoke(method, params) {
    if (typeof window === 'undefined' || !window.gg) return { ok: false, error: { code: 'unavailable', message: '后端未连接，请在 g-group 桌面应用中打开' } }
    return window.gg.invoke(method as never, params as never) as Promise<Result>
  },
  subscribe(listener, options) { return typeof window === 'undefined' ? () => {} : window.gg?.subscribe(listener, options) ?? (() => {}) },
  ...(typeof window !== 'undefined' && 'ggApp' in window ? {
    shell: (method: string, params: Body) => (window as unknown as { ggApp: { invoke(method: string, params: Body): Promise<Result> } }).ggApp.invoke(method, params),
  } : {}),
  get storage() { try { return typeof window === 'undefined' ? undefined : window.localStorage } catch { return undefined } },
}
const liveBridge = createDsBotBridge(browserTransport)
export const call = liveBridge.call
export const openFeed = liveBridge.openFeed
