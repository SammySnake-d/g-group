// 仅供原版/候选视觉对照；不得导入产品入口或用来证明真实后端/模型闭环。
export const FIXTURE_AT = '2026-11-17T10:00:00.000Z'
export const MODEL_ID = 'fengshao1227/deepseek-v4.1-flash'
export const PREVIEW_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="72" viewBox="0 0 200 72"><rect width="200" height="72" rx="12" fill="#edf3ff"/><circle cx="36" cy="36" r="19" fill="#2563eb"/><circle cx="36" cy="36" r="10" fill="#edf3ff"/><text x="68" y="42" font-size="17" font-family="Arial" fill="#183461">g-group</text></svg>'

export function makeVisualFixture() {
  const now = Date.parse(FIXTURE_AT)
  const specs = [
    ['contact-main', '研究助手', '一起把想法落地'],
    ['contact-design', '设计伙伴', '梳理界面与交互'],
    ['contact-code', '代码伙伴', '实现与验证'],
  ]
  const contacts = specs.map(([id, name, bio], index) => ({
    id, name, bio, avatar: null, speakingModel: MODEL_ID, harness: 'codex', computeModel: { mode: 'inherit' }, tools: [], computeAssets: [], activity: 'idle', createdAt: new Date(now - (index + 1) * 60_000).toISOString(),
  }))
  const member = (kind, id) => ({ kind, id })
  const rooms = [
    ...contacts.map((contact, index) => ({ id: ['dm-main', 'dm-design', 'dm-code'][index], kind: 'dm', title: contact.name, members: [member('user', 'user-me'), member('contact', contact.id)] })),
    { id: 'group-project', kind: 'group', title: '产品讨论组', members: [member('user', 'user-me'), ...contacts.map(contact => member('contact', contact.id))] },
  ].map((room, index) => ({ ...room, avatar: null, rules: '', rulesVersion: 0, pinned: false, muted: false, lastSeq: 4, readSeq: 4, unread: 0, pendingForUser: 0, lastMessagePreview: room.kind === 'group' ? '先跑通对话，再逐项完善。' : null, updatedAt: new Date(now - index * 1_000).toISOString() }))
  const texts = [
    ['user', 'user-me', '我们先把聊天闭环跑通，今天做哪几件事？'],
    ['contact', 'contact-main', '今天先完成三件事：\n\n1. 配置 API，选择模型。\n2. 加入联系人，发起私聊。\n3. 建一个群，确认消息能收到。'],
    ['user', 'user-me', '把这份列表留着，再给我一张小图和一行代码。'],
    ['contact', 'contact-main', '可以，先用同一组数据对照界面。\n\n![g-group 预览](/visual-fixture/preview.svg)\n\n```js\nconst ready = true\n```'],
  ]
  const messages = Object.fromEntries(rooms.map(room => [room.id, texts.map(([kind, id, text], index) => ({
    roomId: room.id, seq: index + 1, threadRootSeq: null, sender: { kind, id }, text, mentions: [], replyToSeq: null, quotedSeqs: [], quotes: [], attachments: [], card: null, command: null, reactions: [], edited: false, retracted: false, clientActionId: null, at: new Date(now - 180_000 + index * 25_000).toISOString(),
  }))]))
  const settings = { defaultHarness: 'codex', defaultSpeakingModel: MODEL_ID, defaultComputeModel: MODEL_ID, defaultEffort: 'high', timezone: 'Asia/Shanghai', models: [{ id: MODEL_ID, label: 'DeepSeek v4.1 Flash', vendor: 'fengshao', harnesses: ['codex', 'claude-code'] }] }
  const bots = contacts.map((contact, index) => ({ id: contact.id, sessionId: contact.id, name: contact.name, role: contact.bio, createdAt: Date.parse(contact.createdAt), model: contact.speakingModel, pinned: false, hidden: false, ...(index === 0 ? { avatar: { shape: 'ring' }, color: 'blue' } : {}) }))
  const state = {
    revision: 1, mainBotId: 'contact-main', mainBotIds: [], bots,
    rooms: [{ id: 'group-project', sessionId: 'group-project', name: '产品讨论组', members: contacts.map(contact => contact.id), createdAt: now - 4_000, updatedAt: now - 4_000, preview: '先跑通对话，再逐项完善。', pinned: false, hidden: false }],
    agents: [], sections: [], exchangeTurns: {}, questions: {}, btwCards: {}, sideChats: {}, learning: {}, secrets: [], capabilities: [], capabilityStatuses: {}, phone: null, secretRequests: {}, models: [{ ref: MODEL_ID, id: MODEL_ID, name: 'DeepSeek v4.1 Flash', label: 'DeepSeek v4.1 Flash', provider: 'fengshao' }], defaultModel: MODEL_ID, modelsKey: 'visual-fixture', prefs: { layout: 'bubble', thinking: false, sendsOnEnter: true, motion: 'quiet' }, activity: {}, work: { bots: {}, rooms: {}, approvals: [] }, memoryNews: {}, connectors: [],
  }
  const toItem = message => ({ kind: message.sender.kind === 'user' ? 'user' : 'bot', text: message.text, time: Date.parse(message.at) })
  return { note: '视觉夹具，不是真实模型和后端验收', contacts, rooms, messages, settings, state, toItem }
}

export function originalFixtureCall(fixture, endpoint, payload = {}) {
  switch (endpoint) {
    case 'state': return fixture.state
    case 'chat': {
      const index = fixture.contacts.findIndex(contact => contact.id === payload.botId)
      const roomId = ['dm-main', 'dm-design', 'dm-code'][index]
      return { sessionId: payload.botId, items: (fixture.messages[roomId] ?? []).map(fixture.toItem), cursor: null }
    }
    case 'earlier': return { items: [], cursor: null }
    case 'providers': return { providers: [] }
    case 'diagnostics': return {}
    default: throw new Error(`视觉夹具不实现原版端点：${endpoint}`)
  }
}

// 传入 page.addInitScript 的函数必须自包含；数据通过参数传，不在产品源码放开关。
export function installCandidateFixture(fixture) {
  window.__DSBOT_VISUAL_FIXTURE__ = { note: fixture.note, calls: [] }
  const ok = value => ({ ok: true, value })
  const fail = method => ({ ok: false, error: { code: 'unavailable', message: `视觉夹具未实现 ${method}` } })
  window.gg = {
    apiVersion: '0.1.0',
    invoke: async (method, params) => {
      window.__DSBOT_VISUAL_FIXTURE__.calls.push({ method, params })
      switch (method) {
        case 'session.hello': return ok({ apiVersion: '0.1.0', userId: 'user-me', eventSeq: 0, serverTime: '2026-11-17T10:00:00.000Z' })
        case 'contacts.list': return ok({ contacts: fixture.contacts })
        case 'contacts.get': return ok(fixture.contacts.find(contact => contact.id === params.contactId))
        case 'rooms.list': return ok({ rooms: fixture.rooms })
        case 'rooms.get': return ok(fixture.rooms.find(room => room.id === params.roomId))
        case 'messages.list': return ok({ messages: fixture.messages[params.roomId] ?? [], hasMore: false })
        case 'settings.get': return ok(fixture.settings)
        case 'rooms.markRead': return ok({ ok: true })
        case 'runs.list': return ok({ runs: [] })
        default: return fail(method)
      }
    },
    subscribe: () => () => {},
  }
  window.ggApp = {
    invoke: async (method) => {
      switch (method) {
        case 'setup.get': return ok({ gateway: { baseUrl: 'https://visual-fixture.invalid', model: fixture.settings.defaultSpeakingModel, hasToken: true }, claudePath: null, backend: { state: 'running', mind: 'pi', compute: 'claude' } })
        case 'app.info': return ok({ version: '0.1.0', packaged: false, platform: 'darwin', arch: 'arm64' })
        case 'update.get': return ok({ phase: 'idle', current: '0.1.0' })
        default: return { ok: false, error: `视觉夹具未实现 ${method}` }
      }
    },
    getPathForFile: () => '',
    subscribe: () => () => {},
  }
}
