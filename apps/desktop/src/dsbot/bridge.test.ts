/** 隔离的数据合同测试：不是模型可用性或打包版验收替身。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkParams, checkResult, formatIssues } from '../../../../packages/api-contract/src/bridge.ts'
import type { MethodName } from '../../../../packages/api-contract/src/api.ts'
import type { ContactView, MessageView, RoomView, SettingsView } from '../../../../packages/api-contract/src/entities.ts'
import type { ServerEvent } from '../../../../packages/api-contract/src/events.ts'
import type { SetupView } from '../api/app-shell-types.ts'
import { createDsBotBridge, type DsBotTransport } from './bridge.ts'
import { messageToChatItem } from './chat-message.ts'

const stamp = '2026-11-17T10:00:00.000Z'
const contact = (id: string, name: string): ContactView => ({
  id, name, bio: `${name}介绍`, avatar: null, speakingModel: 'fengshao1227/deepseek-v4.1-flash',
  harness: 'codex', computeModel: { mode: 'inherit' }, tools: [], computeAssets: [], activity: 'idle', createdAt: stamp,
})
const room = (id: string, kind: 'dm' | 'group', ids: string[]): RoomView => ({
  id, kind, title: kind === 'group' ? '项目群' : '私聊', avatar: null,
  members: [{ kind: 'user', id: 'user-me' }, ...ids.map(id => ({ kind: 'contact' as const, id }))],
  rules: '', rulesVersion: 0, pinned: false, muted: false, lastSeq: 2, readSeq: 0, unread: 1,
  pendingForUser: 0, lastMessagePreview: '- 第一项\n- 第二项', updatedAt: stamp,
})
const message = (roomId: string, seq: number, sender: MessageView['sender'], body: string, attachments: MessageView['attachments'] = []): MessageView => ({
  roomId, seq, sender, text: body, attachments, threadRootSeq: null, mentions: [], replyToSeq: null,
  quotedSeqs: [], quotes: [], card: null, command: null, reactions: [], edited: false, retracted: false,
  clientActionId: null, at: stamp,
})
const config: SettingsView = { defaultHarness: 'codex', defaultSpeakingModel: 'fengshao1227/deepseek-v4.1-flash', defaultComputeModel: 'fengshao1227/deepseek-v4.1-flash', defaultEffort: 'high', timezone: 'Asia/Shanghai', models: [{ id: 'fengshao1227/deepseek-v4.1-flash', label: 'DeepSeek Flash', vendor: 'DeepSeek', harnesses: ['codex'] }] }

function fixture() {
  let people = [contact('contact-main', '主联系人'), contact('contact-design', '设计'), contact('contact-code', '研发')]
  let list = [room('dm-main', 'dm', ['contact-main']), room('group-project', 'group', ['contact-main', 'contact-design', 'contact-code'])]
  const messages = new Map([
    ['dm-main', [message('dm-main', 1, { kind: 'user', id: 'user-me' }, '帮我列出计划'), message('dm-main', 2, { kind: 'contact', id: 'contact-main' }, '- 第一项\n- 第二项')]],
    ['group-project', [message('group-project', 1, { kind: 'user', id: 'user-me' }, '大家好'), message('group-project', 2, { kind: 'contact', id: 'contact-design' }, '设计已收到')]],
  ])
  let setup: SetupView = { gateway: { baseUrl: 'https://gateway.invalid', model: config.defaultSpeakingModel, hasToken: true }, claudePath: null, backend: { state: 'running', mind: 'pi', compute: 'claude' } }
  const calls: { method: string; params: Record<string, unknown> }[] = []
  const shellCalls: typeof calls = []
  const storage = new Map<string, string>()
  let listener: ((event: ServerEvent) => void) | null = null
  let unsubscribed = false
  let subscribeOptions: { sinceEventSeq?: number } | undefined
  const transport: DsBotTransport = {
    actionId: () => `action-${calls.length}`,
    storage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => { storage.set(key, value) } },
    subscribe(fn, options) { listener = fn; subscribeOptions = options; return () => { listener = null; unsubscribed = true } },
    async shell(method, params) {
      shellCalls.push({ method, params })
      if (method === 'setup.get') return { ok: true, value: setup }
      if (method === 'setup.models') return { ok: true, value: { models: [{ id: config.defaultSpeakingModel, label: 'DeepSeek Flash' }] } }
      if (method === 'setup.save') {
        setup = { ...setup, gateway: { baseUrl: String(params.baseUrl), model: String(params.model), hasToken: true } }
        return { ok: true, value: setup }
      }
      return { ok: false, error: '未实现测试壳方法' }
    },
    async invoke(method, params) {
      calls.push({ method, params })
      const checked = checkParams(method as MethodName, params)
      assert.ok(checked.ok, `${method} ${checked.ok ? '' : formatIssues(checked.issues)}`)
      let value: unknown
      switch (method) {
        case 'session.hello': value = { apiVersion: '0.1.0', userId: 'user-me', eventSeq: 7, serverTime: stamp }; break
        case 'contacts.list': value = { contacts: people }; break
        case 'rooms.list': value = { rooms: list }; break
        case 'settings.get': value = config; break
        case 'settings.update': value = { ...config, ...params }; break
        case 'messages.list': value = { messages: messages.get(String(params.roomId)) ?? [], hasMore: false }; break
        case 'rooms.openDm': {
          const opened = room(`dm-${String(params.contactId)}`, 'dm', [String(params.contactId)])
          list = [...list, opened]; value = opened; break
        }
        case 'messages.send': {
          const row = message(String(params.roomId), 3, { kind: 'user', id: 'user-me' }, String(params.text), (params.attachments as string[] | undefined)?.map(ref => ({ ref, name: '图片.png', mime: 'image/png', bytes: 8 })))
          value = { ...row, clientActionId: String(params.clientActionId) }; break
        }
        case 'contacts.create': {
          const created = { ...contact('new-contact', String(params.name)), ...(params.speakingModel ? { speakingModel: String(params.speakingModel) } : {}), ...(params.bio ? { bio: String(params.bio) } : {}) }
          people = [...people, created]; value = created; break
        }
        case 'contacts.update': {
          const current = people.find(item => item.id === params.contactId)
          assert.ok(current)
          const { contactId: _id, ...patch } = params
          const changed = { ...current, ...patch } as ContactView
          people = people.map(item => item.id === current.id ? changed : item); value = changed; break
        }
        case 'rooms.createGroup': {
          const created = { ...room('new-group', 'group', (params.members as { id: string }[]).map(item => item.id)), title: String(params.title) }
          list = [...list, created]; value = created; break
        }
        case 'attachments.upload': value = { ref: 'file-image', name: String(params.name), mime: 'image/png', bytes: 8 }; break
        case 'files.read': value = { ref: String(params.ref), name: '图片.png', mime: 'image/png', bytes: 8, encoding: 'base64', content: 'aW1hZ2U=', truncated: false }; break
        default: return { ok: false, error: { code: 'unavailable', message: '测试中未实现' } }
      }
      const result = checkResult(method as MethodName, value)
      assert.ok(result.ok, `${method} ${result.ok ? '' : formatIssues(result.issues)}`)
      return { ok: true, value }
    },
  }
  const bridge = createDsBotBridge(transport)
  return { bridge, calls, shellCalls, storage, transport, getSetup: () => setup, setSetup: (next: SetupView) => { setup = next }, event: (event: ServerEvent) => listener?.(event), options: () => subscribeOptions, unsubscribed: () => unsubscribed }
}

test('state 保留三位联系人、仅群列表、主卡不重复、不虚构总管/群管理者', async () => {
  const f = fixture()
  const state = await f.bridge.call('state') as { bots: { id: string; sessionId: string; avatar?: { shape: string }; color?: string }[]; mainBotId: string; mainBotIds: string[]; rooms: { id: string; admin?: string; preview: string }[]; models: { ref: string }[]; revision: number }
  assert.equal(state.mainBotId, 'contact-main')
  assert.deepEqual(state.mainBotIds, [])
  assert.equal(state.bots.length, 3)
  assert.deepEqual(state.bots[0].avatar, { shape: 'ring' })
  assert.equal(state.bots[0].color, 'blue')
  assert.equal(state.bots[1].avatar, undefined)
  assert.equal(state.bots.filter(bot => bot.id !== state.mainBotId).length, 2)
  assert.deepEqual(state.rooms.map(item => item.id), ['group-project'])
  assert.equal(state.rooms[0].admin, undefined)
  assert.equal(state.rooms[0].preview, '- 第一项\n- 第二项')
  assert.equal(state.bots[0].sessionId, 'contact-main')
  assert.equal(state.models[0].ref, config.defaultSpeakingModel)
  assert.equal((await f.bridge.call('state') as { revision: number }).revision, state.revision)
})

test('DM chat 映射 contact ID 到既有私聊，群 chat 返回真正的群消息与发言人', async () => {
  const f = fixture()
  const dm = await f.bridge.call('chat', { botId: 'contact-main' }) as { sessionId: string; items: { kind: string; text: string }[]; cursor: unknown }
  assert.equal(dm.sessionId, 'contact-main')
  assert.deepEqual(dm.items.map(item => item.kind), ['user', 'bot'])
  assert.equal(dm.items[1].text, '- 第一项\n- 第二项')
  assert.equal(dm.cursor, null)
  assert.ok(f.calls.some(call => call.method === 'messages.list' && call.params.roomId === 'dm-main'))
  assert.ok(!f.calls.some(call => call.method === 'rooms.openDm'))
  const group = await f.bridge.call('chat', { botId: 'group-project' }) as { sessionId: string; items: { kind: string; botId?: string; name?: string }[] }
  assert.equal(group.sessionId, 'group-project')
  assert.equal(group.items[1].kind, 'post')
  assert.equal(group.items[1].botId, 'contact-design')
  assert.equal(group.items[1].name, '设计')
})

test('打开尚无私聊的联系人调用 rooms.openDm；创建联系人与建群使用真实合同', async () => {
  const f = fixture()
  await f.bridge.call('chat', { botId: 'contact-code' })
  assert.ok(f.calls.some(call => call.method === 'rooms.openDm' && call.params.contactId === 'contact-code'))
  const created = await f.bridge.call('create-bot', { name: '新同事', brief: '负责写作', model: config.defaultSpeakingModel, color: 'green', avatar: { shape: 'ring' } }) as { id: string; model: string }
  assert.equal(created.id, 'new-contact')
  assert.equal(created.model, config.defaultSpeakingModel)
  const group = await f.bridge.call('create-room', { members: ['contact-main', 'contact-code'], admin: 'contact-main' }) as { id: string; admin?: string; members: string[] }
  assert.equal(group.id, 'new-group')
  assert.deepEqual(group.members, ['contact-main', 'contact-code'])
  assert.equal(group.admin, undefined)
  const request = f.calls.find(call => call.method === 'rooms.createGroup')
  assert.deepEqual(request?.params.members, [{ kind: 'contact', id: 'contact-main' }, { kind: 'contact', id: 'contact-code' }])
  assert.ok(!Object.hasOwn(request?.params ?? {}, 'admin'))
})

test('附件上传、发送 refs、读取均经既有合同；ChatItem 保留附件供原版接缝渲染', async () => {
  const f = fixture()
  const file = await f.bridge.call('attachment-upload', { name: '图片.png', base64: 'aW1hZ2U=' }) as { ref: string }
  assert.equal(file.ref, 'file-image')
  const sent = await f.bridge.call('send', { sessionId: 'contact-main', text: '', attachments: [file] }) as MessageView
  const request = f.calls.find(call => call.method === 'messages.send')
  assert.equal(request?.params.roomId, 'dm-main')
  assert.deepEqual(request?.params.attachments, ['file-image'])
  const row = messageToChatItem(sent, room('dm-main', 'dm', ['contact-main']), 'user-me', [])
  assert.equal(row.attachments[0].ref, 'file-image')
  assert.equal(row.content[1].type, 'image')
  const read = await f.bridge.call('file-read', { ref: 'file-image' }) as { encoding: string; content: string }
  assert.equal(read.encoding, 'base64')
  assert.equal(read.content, 'aW1hZ2U=')
})

test('feed 从握手游标续订、DM映射UI ID、群发言身份与取消订阅', async () => {
  const f = fixture()
  await f.bridge.call('state')
  const events: { event: string; data: Record<string, unknown> }[] = []
  const stop = f.bridge.openFeed((event, data) => events.push({ event, data }))
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(f.options(), { sinceEventSeq: 7 })
  f.event({ type: 'message.appended', eventSeq: 8, at: stamp, message: message('dm-main', 3, { kind: 'contact', id: 'contact-main' }, '真消息') })
  f.event({ type: 'message.appended', eventSeq: 9, at: stamp, message: message('group-project', 3, { kind: 'contact', id: 'contact-code' }, '群消息') })
  await new Promise(resolve => setImmediate(resolve))
  const messages = events.filter(item => item.event === 'message')
  assert.equal(messages[0].data.botId, 'contact-main')
  assert.equal(messages[0].data.sessionId, 'contact-main')
  assert.equal(messages[1].data.botId, 'group-project')
  assert.equal((messages[1].data.item as { botId: string }).botId, 'contact-code')
  stop(); assert.ok(f.unsubscribed())
})

test('provider 配置委托 setup.*，不声称其他协议可用、令牌不落界面偏好', async () => {
  const f = fixture()
  const providers = await f.bridge.call('providers') as { protocols: string[]; providers: { key: { configured: boolean } }[] }
  assert.deepEqual(providers.protocols, ['anthropic-messages'])
  assert.ok(providers.providers[0].key.configured)
  const found = await f.bridge.call('provider-models', { baseURL: 'https://gateway.invalid', api: 'anthropic-messages', key: 'one-shot-fixture-key' }) as { id: string }[]
  assert.equal(found[0].id, config.defaultSpeakingModel)
  await f.bridge.call('provider-add', { custom: true, baseURL: 'https://gateway.invalid', api: 'anthropic-messages', key: 'one-shot-fixture-key', models: [{ id: config.defaultSpeakingModel }] })
  assert.ok(f.shellCalls.some(call => call.method === 'setup.save' && call.params.token === 'one-shot-fixture-key'))
  assert.ok(![...f.storage.values()].some(value => value.includes('one-shot-fixture-key')))
  await assert.rejects(f.bridge.call('provider-models', { api: 'openai-completions' }), /只接入 Anthropic Messages/)
})

test('未配后端是空态而非演示数据；不支持操作明确拒绝且不调用业务端', async () => {
  const f = fixture()
  f.setSetup({ gateway: null, backend: { state: 'needs-setup' }, claudePath: null })
  const state = await f.bridge.call('state') as { bots: unknown[]; rooms: unknown[]; setupRequired: boolean }
  assert.deepEqual(state.bots, [])
  assert.deepEqual(state.rooms, [])
  assert.equal(state.setupRequired, true)
  assert.equal(f.calls.length, 0)
  await assert.rejects(f.bridge.call('secret-set', { name: 'fixture' }), /没有执行或保存/)
  await assert.rejects(f.bridge.call('set-main', { id: 'contact-main' }), /没有执行或保存/)
  assert.equal(f.calls.length, 0)
})

test('预先取消的请求不触发任何业务调用', async () => {
  const f = fixture()
  const controller = new AbortController(); controller.abort()
  await assert.rejects(f.bridge.call('send', { sessionId: 'contact-main', text: '不应发送' }, controller.signal), { name: 'AbortError' })
  assert.equal(f.calls.length, 0)
})

test('群聊 @名字/@all 转为成员 ID；代码、邮箱、路径不误叫人', async () => {
  const f = fixture()
  await f.bridge.call('send', { sessionId: 'group-project', text: '@设计 看一下 `@研发`，邮箱 a@研发；文件 @研发/readme.md' })
  const first = f.calls.find(call => call.method === 'messages.send')
  assert.deepEqual(first?.params.mentions, [{ id: 'contact-design', source: 'auto' }])
  await f.bridge.call('send', { sessionId: 'group-project', text: '@all 大家好' })
  assert.deepEqual(f.calls.filter(call => call.method === 'messages.send').at(-1)?.params.mentions, ['contact-main', 'contact-design', 'contact-code'].map(id => ({ id, source: 'auto' })))
})

test('首次后端未启动的 feed 在配置保存后重新握手并订阅，不要求重启应用', async () => {
  const f = fixture()
  const original = f.transport.invoke
  let running = false
  f.transport.invoke = (method, params) => running ? original(method, params) : Promise.resolve({ ok: false, error: '后端未连接' })
  const events: string[] = []
  const stop = f.bridge.openFeed(event => events.push(event))
  await new Promise(resolve => setImmediate(resolve))
  assert.ok(events.includes('lost'))
  running = true
  await f.bridge.call('provider-add', { custom: true, baseURL: 'https://gateway.invalid', api: 'anthropic-messages', key: 'one-shot', models: [{ id: config.defaultSpeakingModel }] })
  await new Promise(resolve => setImmediate(resolve))
  assert.ok(events.includes('hello'))
  assert.deepEqual(f.options(), { sinceEventSeq: 7 })
  stop()
})

test('已撤回消息不继续渲染图片或文件入口', () => {
  const original = message('dm-main', 1, { kind: 'user', id: 'user-me' }, '原文', [{ ref: 'private-file', name: '已撤回.png', mime: 'image/png', bytes: 8 }])
  const row = messageToChatItem({ ...original, retracted: true }, room('dm-main', 'dm', ['contact-main']), 'user-me', [])
  assert.equal(row.text, '消息已撤回')
  assert.deepEqual(row.attachments, [])
  assert.equal(row.content.length, 1)
})

test('失败卡在原版消息气泡里保留真实原因，撤回后不泄露失败详情', () => {
  const original: MessageView = {
    ...message('dm-main', 3, { kind: 'contact', id: 'contact-main' }, '这一轮没回成'),
    card: { kind: 'failure', cardId: 'failure-3', taskId: null, title: '这一轮没回成', body: '当前模型不可用：11102，service info not found', state: 'open', actions: [] },
  }
  const row = messageToChatItem(original, room('dm-main', 'dm', ['contact-main']), 'user-me', [])
  assert.equal(row.text, '这一轮没回成\n\n当前模型不可用：11102，service info not found')
  assert.deepEqual(row.content[0], { type: 'text', text: row.text })
  const retracted = messageToChatItem({ ...original, retracted: true }, room('dm-main', 'dm', ['contact-main']), 'user-me', [])
  assert.equal(retracted.text, '消息已撤回')
  assert.deepEqual(retracted.content[0], { type: 'text', text: '消息已撤回' })
})

test('界面偏好可在新桥实例恢复；不支持的组合请求在落业务修改前拒绝', async () => {
  const f = fixture()
  await f.bridge.call('set-prefs', { theme: 'deepseek', enterToSend: false, width: 0.8 })
  const reopened = createDsBotBridge(f.transport)
  const state = await reopened.call('state') as { prefs: { enterToSend: boolean; width: number } }
  assert.equal(state.prefs.enterToSend, false)
  assert.equal(state.prefs.width, 0.8)
  const before = f.calls.length
  await assert.rejects(f.bridge.call('set-prefs', { defaultBotModel: 'would-change', memoryAutoRecall: false }), /尚未接入/)
  assert.equal(f.calls.length, before)
})

test('保存偏好失败不改变当前内存状态，也不伪报成功', async () => {
  const f = fixture()
  f.transport.storage = { getItem: () => null, setItem: () => { throw new Error('测试存储已满') } }
  const bridge = createDsBotBridge(f.transport)
  await assert.rejects(bridge.call('set-prefs', { enterToSend: false }), /存储已满/)
  const state = await bridge.call('state') as { prefs: { enterToSend: boolean } }
  assert.equal(state.prefs.enterToSend, true)
})
