// @ts-nocheck
import { Fragment, createElement as createElement, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ContactView, MessageView, RoomView } from '@g-group/api-contract'
import { call, probeBackend } from '@/api/backend'
import { SHELL_CSS, CONVERSATION_CSS } from './upstream/ds-bot/src/client/styles.js'
import { USER_MESSAGE_CSS } from './upstream/ds-bot/src/client/user-message.js'
import { themeCss, allThemes } from './upstream/ds-bot/src/client/themes.js'
import { TeamSidebar, YouAvatar } from './upstream/ds-bot/src/client/sidebar.js'
import { HeaderPill } from './upstream/ds-bot/src/client/header.js'
import { ChatRows } from './upstream/ds-bot/src/client/cells.js'
import { ComposerPlus, ComposerVoice } from './upstream/ds-bot/src/client/composer.js'
import { ArrowUpIcon } from './upstream/ds-bot/src/client/icons.js'
import './styles.css'

type PendingFile = { id: string; file: File; preview?: string }
type Dialog = 'new' | 'contact' | 'group' | 'settings' | null
type ChatEntry = MessageView
const GButton = (props) => createElement('button', props, props.children)

const CLIENT = () => `dsbot-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
const readableError = (error: { message?: string } | undefined) => error?.message ?? '请求失败，请稍后再试'
const when = (value: string | null | undefined) => {
  const at = value ? Date.parse(value) : NaN
  return Number.isFinite(at) ? at : Date.now()
}

function useUpstreamStyles() {
  useEffect(() => {
    const style = document.createElement('style')
    style.dataset.gGroupDsBot = 'upstream'
    style.textContent = `${SHELL_CSS}${CONVERSATION_CSS}${USER_MESSAGE_CSS}${themeCss(allThemes().deepseek)}`
    document.head.append(style)
    const dark = matchMedia('(prefers-color-scheme: dark)')
    const paint = () => document.body.toggleAttribute('data-ds-dark-theme', dark.matches)
    paint()
    dark.addEventListener('change', paint)
    return () => { dark.removeEventListener('change', paint); style.remove() }
  }, [])
}

function botFor(contact: ContactView) {
  return {
    id: contact.id,
    name: contact.name,
    role: contact.bio,
    avatar: contact.avatar ? { image: contact.avatar } : undefined,
    model: contact.speakingModel,
    createdAt: when(contact.createdAt),
    pinned: false,
    hidden: false,
  }
}

function roomFor(room: RoomView, contacts: ContactView[]) {
  return {
    id: room.id,
    name: room.title,
    title: room.title,
    kind: room.kind,
    sessionId: room.id,
    createdAt: when(room.updatedAt),
    updatedAt: when(room.updatedAt),
    members: room.members.filter((member) => member.kind === 'contact').map((member) => member.id),
    pinned: room.pinned,
    hidden: false,
    preview: room.lastMessagePreview ?? '',
    admin: room.members.find((member) => member.kind === 'contact')?.id,
    contacts,
  }
}

function makeRoster(contacts: ContactView[], rooms: RoomView[], userId: string, selected: string | null) {
  const bots = contacts.map((contact, index) => ({
    ...botFor(contact),
    // The first real contact occupies DS-Bot's Main Bot seat.  Keeping the
    // whale look here gives the same visual anchor as the upstream product
    // without inventing a second g-group entity.
    ...(index === 0 && !contact.avatar ? { avatar: { shape: 'whale' }, color: 'deepseek' } : {}),
  }))
  // DS-Bot's shell reserves the first Bot as the Main Bot tile.  g-group does
  // not have a separate synthetic "Chief" entity, so keep that visual slot
  // bound to the first real contact and leave the rest in the conversation list.
  const mainBotId = bots[0]?.id ?? null
  const roomViews = rooms.map((room) => roomFor(room, contacts))
  const byId = Object.fromEntries(bots.map((bot) => [bot.id, bot]))
  return {
    revision: rooms.length + contacts.length,
    mainBotId,
    mainBotIds: mainBotId ? [mainBotId] : [],
    bots,
    rooms: roomViews,
    agents: [],
    sections: [],
    exchangeTurns: {},
    questions: {},
    btwCards: {},
    sideChats: {},
    learning: {},
    secrets: [],
    capabilities: [],
    capabilityStatuses: {},
    phone: null,
    secretRequests: {},
    models: [],
    defaultModel: 'fengshao1227/deepseek-v4.1-flash',
    modelsKey: null,
    prefs: { layout: 'bubble', thinking: false, sendsOnEnter: true },
    byId,
    roomsById: Object.fromEntries(roomViews.map((room) => [room.id, room])),
    agentsById: {},
    agentOf: {},
    ready: true,
    userId,
    selected,
  }
}

function useRosterData() {
  const [contacts, setContacts] = useState<ContactView[]>([])
  const [rooms, setRooms] = useState<RoomView[]>([])
  const [messages, setMessages] = useState<Record<string, ChatEntry[]>>({})
  const [selected, setSelected] = useState<string | null>(null)
  const [userId, setUserId] = useState('me')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const loadMessages = useCallback(async (roomId: string) => {
    const result = await call('messages.list', { roomId, limit: 200 })
    if (result.ok) setMessages((old) => ({ ...old, [roomId]: result.value.messages }))
  }, [])

  const refresh = useCallback(async (preferred?: string | null) => {
    setError('')
    try {
      const [people, list, session] = await Promise.all([call('contacts.list', {}), call('rooms.list', {}), probeBackend()])
      if (!people.ok) throw new Error(readableError(people.error))
      if (!list.ok) throw new Error(readableError(list.error))
      setContacts(people.value.contacts)
      setRooms(list.value.rooms)
      if (session.mode === 'connected') setUserId(session.userId)
      const next = preferred ?? selected ?? list.value.rooms[0]?.id ?? null
      setSelected(next)
      if (next) await loadMessages(next)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }, [loadMessages, selected])

  useEffect(() => { void refresh() }, [refresh])
  useEffect(() => {
    const bridge = typeof window !== 'undefined' && 'gg' in window
      ? (window as unknown as { gg: { subscribe: (fn: (event: unknown) => void) => () => void } }).gg
      : null
    const stop = bridge?.subscribe((event) => {
      const type = (event as { type?: string }).type
      if (type === 'message.appended' || type === 'message.updated' || type === 'room.updated' || type === 'room.removed' || type === 'contact.updated' || type === 'contact.removed') void refresh()
    })
    return () => stop?.()
  }, [refresh])

  const select = useCallback(async (roomId: string) => {
    setSelected(roomId)
    await loadMessages(roomId)
  }, [loadMessages])

  return { contacts, rooms, messages, selected, userId, loading, error, refresh, select }
}

function useInput(field, setText) {
  return useMemo(() => ({
    captureInsertion: () => field.current ? { start: field.current.selectionStart, end: field.current.selectionEnd } : null,
    insertText: (value, at) => setText((current) => {
      const start = Math.min(at?.start ?? current.length, current.length)
      return current.slice(0, start) + value + current.slice(Math.max(start, at?.end ?? start))
    }),
  }), [field, setText])
}

function toUpstreamItem(message: MessageView, userId: string, contacts: ContactView[], roomId: string) {
  const time = when(message.at)
  if (message.sender.kind === 'user' && message.sender.id === userId) return { kind: 'user', text: message.text, time, images: message.attachments.filter((item) => item.mime.startsWith('image/')).length }
  const contact = contacts.find((entry) => entry.id === message.sender.id)
  if (message.sender.kind === 'contact' || message.sender.kind === 'helper') {
    return { kind: 'post', botId: message.sender.id, name: contact?.name ?? (message.sender.kind === 'helper' ? 'Helper' : message.sender.id), text: message.text, roomId, seq: message.seq, time }
  }
  return { kind: 'event', role: 'report', name: '系统', text: message.text, roomId, time }
}

function AttachmentCards({ message, onOpen }) {
  if (message.attachments.length === 0) return null
  return <div className="gg-message-files">{message.attachments.map((attachment) => <GButton key={attachment.ref} type="button" className="gg-file-card" onClick={() => onOpen(attachment.ref)}><span className="gg-file-kind">{attachment.mime.startsWith('image/') ? 'image' : 'file'}</span><span><strong>{attachment.name}</strong><small>{attachment.mime} · {attachment.bytes} B</small></span></GButton>)}</div>
}

function GGroupComposer({ room, roster, actions, onSent }) {
  const [text, setText] = useState('')
  const [pending, setPending] = useState<PendingFile[]>([])
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const field = useRef(null)
  const inputActions = useInput(field, setText)
  const files = useRef(null)
  const queueFiles = (list) => {
    if (!list) return
    const additions = [...list].map((file) => ({ id: `${file.name}-${file.lastModified}-${Math.random()}`, file, preview: file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined }))
    setPending((old) => [...old, ...additions])
  }
  useEffect(() => () => pending.forEach((item) => item.preview && URL.revokeObjectURL(item.preview)), [pending])
  const send = async () => {
    const value = text.trim()
    if ((!value && pending.length === 0) || sending) return
    setSending(true); setError('')
    try {
      const attachments: string[] = []
      for (const item of pending) {
        const bytes = new Uint8Array(await item.file.arrayBuffer())
        let binary = ''
        for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000))
        const uploaded = await call('attachments.upload', { name: item.file.name, base64: btoa(binary) })
        if (!uploaded.ok) throw new Error(readableError(uploaded.error))
        attachments.push(uploaded.value.ref)
      }
      const result = await call('messages.send', { roomId: room.id, clientActionId: CLIENT(), text: value, ...(attachments.length ? { attachments } : {}) })
      if (!result.ok) throw new Error(readableError(result.error))
      setText(''); setPending([]); await onSent(room.id)
      field.current?.focus()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally { setSending(false) }
  }
  return <div className="dsh_composerRoot">
    <div className="dsh_composerWrap">
      {error && <p className="dsb-composer-error" role="alert">{error}</p>}
      {pending.length > 0 && <div className="gg-pending-row">{pending.map((item) => <div key={item.id} className="gg-pending-item">{item.preview ? <img src={item.preview} alt={item.file.name} /> : <span>file</span>}<small>{item.file.name}</small><GButton type="button" aria-label={`移除 ${item.file.name}`} onClick={() => setPending((old) => old.filter((entry) => entry.id !== item.id))}>×</GButton></div>)}</div>}
      <div className="dsh_composer" data-composer-card data-multiline={text.includes('\n') || undefined}>
        <div className="dsh_tools"><ComposerPlus sessionId={room.id} inputActions={inputActions} useInput={() => false} useRoster={(selector) => selector(roster)} actions={actions} /></div>
        <div className="dsh_input"><textarea ref={field} rows={1} value={text} disabled={sending} placeholder={`Message ${room.name}`} aria-label={`Message ${room.name}`} onChange={(event) => setText(event.target.value)} onPaste={(event) => queueFiles(event.clipboardData.files)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send() } }} /></div>
        <div className="dsh_trailing"><ComposerVoice sessionId={room.id} inputActions={inputActions} actions={actions} useUi={(selector) => selector({ quote: null })} useRoster={(selector) => selector(roster)} /><GButton type="button" className="bt-send" aria-label="Send message" disabled={sending || (!text.trim() && pending.length === 0)} onClick={() => void send()}><ArrowUpIcon /></GButton></div>
        <input ref={files} type="file" multiple hidden onChange={(event) => { queueFiles(event.currentTarget.files); event.currentTarget.value = '' }} />
      </div>
    </div>
  </div>
}

function GGroupChat({ roster, room, messages, contacts, userId, actions, onSent }) {
  const [filePreview, setFilePreview] = useState(null)
  const openFile = async (ref) => {
    const result = await call('files.read', { ref, maxBytes: 16 * 1024 * 1024 })
    if (!result.ok) { actions.reportError(result.error, 'file'); return }
    setFilePreview(result.value.encoding === 'base64' ? `data:${result.value.mime};base64,${result.value.content}` : result.value.content)
  }
  const items = messages[room.id] ?? []
  return <div className="dsh_chat">
    <div className="dsh_scroll" data-conversation-scroll>
      <div className="dsh_column"><div className="dsh_flow" data-chat-flow role="feed" aria-label={room.name}>
        {items.length === 0 && <div className="gg-empty"><span>✦</span><h2>开始与 {room.name} 对话</h2><p>消息通过 g-group 真实后端发送。</p></div>}
        {items.map((message) => <Fragment key={`${message.roomId}-${message.seq}`}><ChatRows items={[toUpstreamItem(message, userId, contacts, room.id)]} sessionId={room.id} roster={roster} actions={actions} useUi={(selector) => selector({ reactions: {} })} clock /><AttachmentCards message={message} onOpen={(ref) => void openFile(ref)} /></Fragment>)}
      </div></div>
    </div>
    <GGroupComposer room={room} roster={roster} actions={actions} onSent={onSent} />
    {filePreview && <div className="gg-lightbox" role="dialog" onClick={() => setFilePreview(null)}><GButton type="button" aria-label="关闭预览">×</GButton>{filePreview.startsWith('data:image/') ? <img src={filePreview} alt="附件预览" /> : <pre>{filePreview}</pre>}</div>}
  </div>
}

function ContactDialog({ roster, onClose, onSaved }) {
  const [name, setName] = useState('')
  const [bio, setBio] = useState('')
  const [busy, setBusy] = useState(false)
  const save = async () => {
    if (!name.trim()) return
    setBusy(true)
    const result = await call('contacts.create', { clientActionId: CLIENT(), name: name.trim(), ...(bio.trim() ? { bio: bio.trim() } : {}) })
    if (!result.ok) window.alert(readableError(result.error))
    else { const room = await call('rooms.openDm', { contactId: result.value.id }); await onSaved(room.ok ? room.value.id : null); onClose() }
    setBusy(false)
  }
  return <div className="gg-dialog-backdrop"><form className="gg-dialog" onSubmit={(event) => { event.preventDefault(); void save() }}><h2>添加联系人</h2><label>名称<input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="比如：研究助手" /></label><label>职责（可选）<input value={bio} onChange={(event) => setBio(event.target.value)} placeholder="它擅长什么" /></label><div className="gg-dialog-actions"><GButton type="button" onClick={onClose}>取消</GButton><GButton className="primary" disabled={busy || !name.trim()}>添加</GButton></div></form></div>
}

function GroupDialog({ roster, onClose, onSaved }) {
  const [title, setTitle] = useState('')
  const [members, setMembers] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const save = async () => {
    if (!title.trim() || members.length === 0) return
    setBusy(true)
    const result = await call('rooms.createGroup', { clientActionId: CLIENT(), title: title.trim(), members: members.map((id) => ({ kind: 'contact' as const, id })) })
    if (!result.ok) window.alert(readableError(result.error))
    else { await onSaved(result.value.id); onClose() }
    setBusy(false)
  }
  return <div className="gg-dialog-backdrop"><form className="gg-dialog" onSubmit={(event) => { event.preventDefault(); void save() }}><h2>新建群聊</h2><label>群名称<input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} placeholder="比如：产品讨论" /></label><fieldset><legend>选择联系人</legend>{roster.bots.map((contact) => <label key={contact.id} className="gg-check"><input type="checkbox" checked={members.includes(contact.id)} onChange={(event) => setMembers((old) => event.target.checked ? [...old, contact.id] : old.filter((id) => id !== contact.id))} />{contact.name}</label>)}</fieldset><div className="gg-dialog-actions"><GButton type="button" onClick={onClose}>取消</GButton><GButton className="primary" disabled={busy || !title.trim() || members.length === 0}>创建群聊（{members.length + 1} 人）</GButton></div></form></div>
}

function SettingsDialog({ roster, onClose }) {
  return <div className="gg-dialog-backdrop"><div className="gg-dialog"><h2>会话信息</h2><p className="gg-dialog-note">当前界面由 DS-Bot 前端组件渲染，数据由 g-group 后端提供。</p><dl className="gg-facts"><div><dt>联系人</dt><dd>{roster.bots.length}</dd></div><div><dt>会话</dt><dd>{roster.rooms.length}</dd></div><div><dt>模型</dt><dd>fengshao1227/deepseek-v4.1-flash</dd></div></dl><div className="gg-dialog-actions"><GButton className="primary" onClick={onClose}>完成</GButton></div></div></div>
}

function NewActionsDialog({ onClose, onContact, onGroup }) {
  return <div className="gg-dialog-backdrop"><div className="gg-dialog gg-new-actions"><h2>新建</h2><p className="gg-dialog-note">沿用 DS-Bot 的新建入口，选择 g-group 会话类型。</p><div className="gg-new-action-list"><GButton type="button" onClick={onContact}>联系人</GButton><GButton type="button" onClick={onGroup}>群聊</GButton></div><div className="gg-dialog-actions"><GButton type="button" onClick={onClose}>取消</GButton></div></div></div>
}

export function DsBotApp() {
  useUpstreamStyles()
  const data = useRosterData()
  const [dialog, setDialog] = useState<Dialog>(null)
  const [sidebarPref, setSidebarPrefState] = useState<'open' | 'rail' | 'hidden'>('open')
  const room = data.rooms.find((entry) => entry.id === data.selected) ?? null
  const roster = useMemo(() => makeRoster(data.contacts, data.rooms, data.userId, data.selected), [data.contacts, data.rooms, data.userId, data.selected])
  const sessions = useMemo(() => {
    const byId = Object.fromEntries(data.rooms.map((entry) => [entry.id, {
      id: entry.id,
      title: entry.title,
      displayTitle: entry.title,
      updatedAt: when(entry.updatedAt),
      retainedBy: { mainView: entry.id === data.selected ? 1 : 0 },
    }]))
    // BotRow asks DS-Bot for the contact's currentPart (its sessionId or id),
    // while g-group stores the selected DM under a room id.  Add those aliases
    // so the Main Bot tile and each contact row receive the same active state.
    for (const contact of data.contacts) {
      const dm = data.rooms.find((entry) => entry.kind === 'dm' && entry.members.some((member) => member.kind === 'contact' && member.id === contact.id))
      if (dm) byId[contact.id] = { id: contact.id, title: contact.name, displayTitle: contact.name, updatedAt: when(dm.updatedAt), retainedBy: { mainView: dm.id === data.selected ? 1 : 0 } }
    }
    return { ids: Object.keys(byId), byId }
  }, [data.contacts, data.rooms, data.selected])
  const ui = useMemo(() => ({ details: null, view: 'details', visits: {}, unread: {}, reactions: {}, quote: null }), [])
  const status = useMemo(() => new Map(), [])
  const activity = useMemo(() => ({}), [])
  const work = useMemo(() => ({ rooms: {}, bots: {}, approvals: [] }), [])
  const useRoster = useCallback((selector) => selector(roster), [roster])
  const useUi = useCallback((selector) => selector(ui), [ui])
  const useSessions = useCallback((selector) => selector(sessions), [sessions])
  const useSessionStatus = useCallback((selector) => selector(status), [status])
  const useSessionRetainInfo = useCallback((id, selector) => selector(sessions.byId[id] ?? { retainedBy: { mainView: 0 } }), [sessions])
  const useActivity = useCallback((selector) => selector(activity), [activity])
  const useWork = useCallback((selector) => selector(work), [work])
  const useMemoryNews = useCallback((selector) => selector({}), [])
  const useTurnClock = useCallback((selector) => selector({}), [])
  const useLive = useCallback((selector) => selector({}), [])
  const useRegistry = useCallback((selector) => selector(0), [])
  const useUpdate = useCallback((selector) => selector({ available: false, phase: 'idle' }), [])
  const useFrame = useCallback((selector) => selector({ viewport: typeof window === 'undefined' ? 1320 : window.innerWidth, sidebarWidth: 430, collapsedWidth: 0 }), [])
  const useSidebarPref = useCallback((selector) => selector(sidebarPref), [sidebarPref])
  const actions = useMemo(() => ({
    openSession: (id) => { const target = data.rooms.find((entry) => entry.id === id) ?? data.rooms.find((entry) => entry.kind === 'dm' && entry.members.some((member) => member.kind === 'contact' && member.id === id)); if (target) void data.select(target.id) },
    openNewChat: () => setDialog('new'),
    openSettings: () => setDialog('settings'),
    toggleSidebar: () => setSidebarPrefState((value) => value === 'hidden' ? 'open' : 'hidden'),
    toggleLeftHidden: () => setSidebarPrefState((value) => value === 'hidden' ? 'open' : 'hidden'),
    openPalette: () => {},
    openMenu: () => {},
    setFlags: async () => {},
    saveSection: async () => ({}),
    beginSectionRename: () => {},
    endSectionRename: () => {},
    setSidebarWidth: () => {},
    setSidebarPref: (value) => setSidebarPrefState(value),
    setLeftDrawer: () => {},
    setPanelYield: () => {},
    beginVisit: () => {},
    endVisit: () => {},
    toggleDetails: () => setDialog('settings'),
    openMemory: () => {},
    clearLive: () => {},
    noteLive: () => {},
    noteSent: () => {},
    toggleReaction: () => {},
    quote: () => {},
    clearQuote: () => {},
    reportError: (error, where) => console.warn(`[g-group/${where}]`, error),
    speech: () => undefined,
    openVoice: () => {},
    canReferenceChat: () => false,
    referenceChat: () => {},
    steerQueued: async () => {},
    composeGoal: () => {},
    openExchange: () => {},
  }), [data.rooms, data.select])
  const views = { useRoster, useUi, useSessions, useSessionStatus, useSessionRetainInfo, useActivity, useWork, useRegistry, useUpdate, useMemoryNews, useTurnClock, useLive, useFrame, useSidebarPref, actions }
  const selectedRoom = room ? roster.roomsById[room.id] : null
  return <div className="dsb-frame" data-testid="dsbot-frame">
    {/* There is no DSH shell sidebar in this host.  Passing a collapsed shell
        hint prevents the upstream sync effect from toggling our own column on
        mount; TeamSidebar still computes its open/rail/hidden mode from the
        real useSidebarPref source above. */}
    <TeamSidebar {...views} wide={false} />
    <main className="dsh_centerCol dsb-main">
      {selectedRoom && <header className="dsh_header"><HeaderPill {...views} sessionId={selectedRoom.id} useSession={() => (selector) => selector({ pendingSubmissions: [] })} /></header>}
      {room ? <GGroupChat roster={roster} room={selectedRoom} messages={data.messages} contacts={data.contacts} userId={data.userId} actions={actions} onSent={async (id) => { await data.refresh(id) }} /> : <div className="gg-empty-page">{data.loading ? '正在加载 g-group 会话…' : data.error || '还没有会话，请从 DS-Bot 的 ＋ 新建联系人。'}</div>}
    </main>
    {dialog === 'new' && <NewActionsDialog onClose={() => setDialog(null)} onContact={() => setDialog('contact')} onGroup={() => setDialog('group')} />}
    {dialog === 'contact' && <ContactDialog roster={roster} onClose={() => setDialog(null)} onSaved={async (id) => { await data.refresh(id) }} />}
    {dialog === 'group' && <GroupDialog roster={roster} onClose={() => setDialog(null)} onSaved={async (id) => { await data.refresh(id) }} />}
    {dialog === 'settings' && <SettingsDialog roster={roster} onClose={() => setDialog(null)} />}
  </div>
}
