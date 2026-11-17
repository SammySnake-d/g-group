import test from 'node:test'
import assert from 'node:assert/strict'
import { checkResult } from '../../../packages/api-contract/src/bridge.ts'
import { installCandidateFixture, makeVisualFixture, originalFixtureCall } from './dsbot-visual-fixture.mjs'

test('原版视觉夹具只设一张主卡并保留另外两位联系人和一个群', () => {
  const fixture = makeVisualFixture()
  assert.equal(fixture.state.mainBotId, 'contact-main')
  assert.deepEqual(fixture.state.mainBotIds, [])
  assert.equal(fixture.state.bots.length, 3)
  assert.equal(fixture.state.rooms.length, 1)
  assert.deepEqual(fixture.state.bots[0].avatar, { shape: 'ring' })
  assert.equal(fixture.state.bots[0].color, 'blue')
  assert.equal(fixture.state.models[0].ref, fixture.settings.defaultSpeakingModel)
  assert.equal(fixture.state.rooms[0].preview, fixture.rooms.find(room => room.id === 'group-project').lastMessagePreview)
})

test('原版和候选读取同一份消息和 Markdown，不捏造模型请求', async () => {
  const fixture = makeVisualFixture()
  const chat = originalFixtureCall(fixture, 'chat', { botId: 'contact-main' })
  assert.equal(chat.sessionId, 'contact-main')
  assert.equal(chat.items.length, fixture.messages['dm-main'].length)
  assert.deepEqual(chat.items.map(item => item.text), fixture.messages['dm-main'].map(item => item.text))
  assert.match(chat.items[1].text, /1\. 配置 API/)
  assert.match(chat.items[3].text, /!\[g-group 预览\]/)
  globalThis.window = {}
  try {
    installCandidateFixture(fixture)
    for (const method of ['session.hello', 'contacts.list', 'rooms.list', 'messages.list', 'settings.get']) {
      const result = await window.gg.invoke(method, { roomId: 'dm-main' })
      assert.equal(result.ok, true)
      assert.equal(checkResult(method, result.value).ok, true, method)
    }
    assert.equal((await window.gg.invoke('messages.send', {})).ok, false)
    assert.throws(() => originalFixtureCall(fixture, 'send', {}), /不实现/)
  } finally { delete globalThis.window }
})
