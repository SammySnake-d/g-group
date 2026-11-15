import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type RequestListener } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'

const appDir = path.resolve(import.meta.dirname, '..')
const env = Object.fromEntries(Object.entries(process.env).filter(([k, v]) => k !== 'ELECTRON_RUN_AS_NODE' && !k.startsWith('GG_') && !k.startsWith('ANTHROPIC_') && typeof v === 'string'))
const serverAt = async (handler: RequestListener) => {
  const server = createServer(handler)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('没有端口')
  return { server, url: `http://127.0.0.1:${address.port}` }
}

test('API 身份:旧目录回包不能覆盖新地址，换地址留空令牌时既不能读目录也不能保存旧凭据', async () => {
  let release: (() => void) | undefined
  let arrived: (() => void) | undefined
  const requestArrived = new Promise<void>((r) => { arrived = r })
  const old = await serverAt((_req, res) => {
    release = () => { if (!res.writableEnded) res.writeHead(200).end(JSON.stringify({ data: [{ id: 'old-model' }] })) }
    arrived?.()
  })
  let requests = 0
  const current = await serverAt((_req, res) => {
    requests++
    res.writeHead(200).end(JSON.stringify({ data: [{ id: 'current-model' }] }))
  })
  const dir = mkdtempSync(path.join(tmpdir(), 'gg-api-identity-'))
  const app = await electron.launch({ args: [appDir], cwd: appDir, env: { ...env, GG_BACKEND: 'server', GG_COMPUTE: 'fake', GG_UPDATE_AUTO: 'off', GG_USER_DATA_DIR: dir } })
  try {
    const win = await app.firstWindow()
    await win.getByTestId('setup-base-url').fill(old.url)
    await win.getByTestId('setup-token').fill('NEUTRAL_OLD_TOKEN')
    await win.getByTestId('setup-models-load').click()
    await requestArrived
    await win.getByTestId('setup-base-url').fill(current.url)
    await win.getByTestId('setup-token').fill('NEUTRAL_CURRENT_TOKEN')
    await win.getByTestId('setup-models-load').click()
    await expect(win.getByTestId('setup-model-options')).toContainText('current-model')
    release?.()
    // 旧调用仍在飞行，等待它实际回包，断言目录没有回退。
    await win.evaluate(async () => new Promise((r) => setTimeout(r, 250)))
    await expect(win.getByTestId('setup-model-options')).not.toContainText('old-model')
    await win.getByTestId('setup-model-options').selectOption('current-model')
    await win.getByTestId('setup-save').click()
    await expect(win.getByTestId('backend-demo')).toHaveAttribute('data-mode', 'connected', { timeout: 30000 })
    const invoke = (method: string, baseUrl: string) => win.evaluate(({ method, baseUrl }) => (window as unknown as { ggApp: { invoke: (m: string, p: unknown) => Promise<unknown> } }).ggApp.invoke(method, { baseUrl, model: 'current-model' }), { method, baseUrl })
    expect(await invoke('setup.models', old.url)).toMatchObject({ ok: false, error: '先填令牌' })
    expect(await invoke('setup.save', old.url)).toMatchObject({ ok: false, error: '请填令牌' })
    expect(JSON.parse(readFileSync(path.join(dir, 'gg-config.json'), 'utf8')).gateway).toMatchObject({ baseUrl: current.url, token: 'NEUTRAL_CURRENT_TOKEN' })
    expect(requests).toBe(1)
    expect(await invoke('setup.models', current.url + '/')).toMatchObject({ ok: true })
  } finally {
    release?.()
    await app.close()
    old.server.close(); current.server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('异步模型失败:原位展示原因，换模型保存被拒不报成功，改好后由用户重试本轮', async () => {
  test.setTimeout(120000)
  let roomId = ''
  const seen: string[] = []
  let replySent = false
  const gateway = await serverAt(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw)
    seen.push(body.model)
    if (body.model === 'neutral-blocked') {
      res.writeHead(403, { 'content-type': 'application/json' }).end(JSON.stringify({ type: 'error', error: { type: 'permission_error', message: 'NEUTRAL_FIXTURE_MODEL_DENIED: choose another model' } }))
      return
    }
    const event = (type: string, value: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`
    let sse = event('message_start', { message: { id: 'msg_fixture', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } })
    if (!replySent) {
      sse += event('content_block_start', { index: 0, content_block: { type: 'tool_use', id: 'toolu_fixture', name: 'reply', input: {} } })
      sse += event('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ roomId, text: 'FIXTURE_RECOVERY_OK' }) } })
      sse += event('content_block_stop', { index: 0 })
    }
    sse += event('message_delta', { delta: { stop_reason: replySent ? 'end_turn' : 'tool_use', stop_sequence: null }, usage: { output_tokens: 5 } })
    sse += event('message_stop', {})
    replySent = true
    res.writeHead(200, { 'content-type': 'text/event-stream' }).end(sse)
  })
  const dir = mkdtempSync(path.join(tmpdir(), 'gg-model-recovery-'))
  writeFileSync(path.join(dir, 'gg-config.json'), JSON.stringify({ gateway: { baseUrl: gateway.url, model: 'neutral-blocked', token: 'NEUTRAL_FIXTURE_TOKEN' } }), { mode: 0o600 })
  const app = await electron.launch({ args: [appDir], cwd: appDir, env: { ...env, GG_BACKEND: 'server', GG_USER_DATA_DIR: dir, GG_COMPUTE: 'fake', GG_UPDATE_AUTO: 'off' } })
  try {
    const win = await app.firstWindow()
    win.setDefaultTimeout(30000)
    await expect(win.getByTestId('backend-demo')).toHaveAttribute('data-mode', 'connected')
    await win.getByTestId('nav-contacts').click()
    await win.getByTestId('list').getByText('添加联系人', { exact: true }).click()
    await win.getByPlaceholder('比如：设计师').fill('恢复测试')
    await win.getByRole('button', { name: '添加', exact: true }).click()
    await win.getByTestId('composer').fill('请回复')
    await win.getByTestId('composer').press('Enter')
    const mine = win.getByTestId('chat-column').locator('[data-from="me"][data-msg]').last()
    await expect(mine).toHaveAttribute('data-msg', /#\d+$/)
    roomId = (await mine.getAttribute('data-msg'))!.split('#')[0]
    const details = win.locator('[data-testid^="failure-details-"]').first()
    await expect(details).toBeVisible()
    await details.getByRole('button', { name: '查看完整原因' }).click()
    await expect(details).toContainText('NEUTRAL_FIXTURE_MODEL_DENIED')
    await details.getByRole('button', { name: '换模型', exact: true }).click()
    await win.getByTestId('cm-talk').selectOption('__other__')
    await win.getByTestId('cm-talk-other').fill('x'.repeat(201))
    await win.getByTestId('cm-talk-other-ok').click()
    await win.getByTestId('cm-save').click()
    await expect(win.getByTestId('toast')).toContainText('没保存上')
    await expect(win.getByTestId('cm-save')).toBeEnabled()
    await expect(win.getByTestId('next-turn')).toHaveCount(0)
    await win.getByTestId('cm-talk').selectOption('__other__')
    await win.getByTestId('cm-talk-other').fill('neutral-ready')
    await win.getByTestId('cm-talk-other-ok').click()
    // 新填模型与 follow-speaking 的预检也必须允许保存。
    await win.getByTestId('cm-mode-follow-speaking').click()
    await win.getByTestId('cm-save').click()
    await expect(win.getByTestId('next-turn')).toContainText('已保存')
    expect(seen.every((id) => id === 'neutral-blocked')).toBe(true)
    await win.getByTestId('wb-dm').click()
    await win.getByRole('button', { name: /^重试(?:本轮)?(?: 推荐)?$/ }).first().click()
    await expect(win.getByTestId('chat-column')).toContainText('FIXTURE_RECOVERY_OK')
    expect(seen).toContain('neutral-ready')
  } finally {
    await app.close(); gateway.server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
