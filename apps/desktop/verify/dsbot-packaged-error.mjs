// A local SSE fixture drives the actual ZIP's pi adapter, Host, IPC and renderer.
// It is an error-path CONTROL, not a request to fengshao or another provider.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { createHash } from 'node:crypto'
import { _electron as electron, expect } from '@playwright/test'

const opt = (key, fallback) => { const i = process.argv.indexOf(key); return i < 0 ? fallback : process.argv[i + 1] }
const appPath = path.resolve(opt('--app', 'release/mac-arm64/g-group.app'))
const out = path.resolve(opt('--out', '/tmp/dsbot-astra-20261117/packaged-error-r6'))
mkdirSync(out, { recursive: true })
const data = mkdtempSync(path.join(tmpdir(), 'dsbot-packaged-error-'))
const model = 'fengshao1227/deepseek-v4.1-flash'
const requests = []
const receipt = { mode: 'packaged pi/Host/IPC/UI with local SSE error fixture', realModelAcceptance: false, appPath, model, startedAt: new Date().toISOString(), errors: [] }
const server = createServer(async (req, res) => {
  let body = ''
  for await (const chunk of req) body += chunk
  if (req.method !== 'POST' || new URL(req.url, 'http://127.0.0.1').pathname !== '/v1/messages') { res.writeHead(404).end(); return }
  requests.push({ url: req.url, model: JSON.parse(body).model })
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
  res.write('event: keepalive\ndata: {}\n\n')
  res.end(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'model_unavailable', message: '当前模型不可用，请切换模型', code: 11102, msg: 'model [hy4-flash-free] service info not found' } })}\n\n`)
})
server.listen(0, '127.0.0.1')
await once(server, 'listening')
writeFileSync(path.join(data, 'gg-config.json'), JSON.stringify({ gateway: { baseUrl: `http://127.0.0.1:${server.address().port}`, model, token: ['offline', 'fixture'].join('-') } }), { mode: 0o600 })
let app, win
try {
  app = await electron.launch({ executablePath: path.join(appPath, 'Contents/MacOS/g-group'), args: ['--lang=zh-CN'], env: { ...process.env, GG_USER_DATA_DIR: data, GG_BACKEND: 'server', GG_MIND: 'pi', GG_COMPUTE: 'fake', GG_UPDATE_AUTO: 'off', GG_DEV_URL: '', ELECTRON_RUN_AS_NODE: '' } })
  win = await app.firstWindow()
  win.setDefaultTimeout(12_000)
  win.on('pageerror', error => receipt.errors.push(error.message))
  await win.locator('.dsb-frame').waitFor()
  await win.getByRole('button', { name: '新建', exact: true }).click()
  await win.getByRole('option', { name: '新建 Bot', exact: true }).click()
  await win.getByRole('textbox', { name: '名字', exact: true }).fill('错误回放联系人')
  await win.getByRole('button', { name: '创建', exact: true }).click()
  await win.locator('[data-bot-id]').filter({ hasText: '错误回放联系人' }).first().waitFor()
  await win.keyboard.press('Escape')
  await win.locator('[data-bot-id]').filter({ hasText: '错误回放联系人' }).first().click()
  const began = performance.now()
  await win.locator('.dsb-composer textarea').fill('离线错误回放，不发真实模型请求')
  await win.getByRole('button', { name: '发送', exact: true }).click()
  await expect(win.locator('.dsb-flow')).toContainText('11102')
  await expect(win.locator('.dsb-flow')).toContainText('service info not found')
  receipt.elapsedMs = Math.round(performance.now() - began)
  receipt.ledger = await win.evaluate(() => window.gg.invoke('runs.list', {}))
  receipt.contacts = await win.evaluate(() => window.gg.invoke('contacts.list', {}))
  assert.ok(receipt.ledger.ok)
  assert.ok(receipt.ledger.value.runs.some(run => run.status === 'failed'))
  assert.ok(!receipt.ledger.value.runs.some(run => run.status === 'running'))
  assert.equal(receipt.contacts.value.contacts[0].activity, 'idle')
  assert.equal(requests.length, 1)
  assert.equal(requests[0].model, model)
  assert.deepEqual(receipt.errors, [])
  receipt.screenshot = path.join(out, 'failure-visible.png')
  await win.screenshot({ path: receipt.screenshot })
  receipt.outcome = 'error-visible-run-failed-contact-idle'
} catch (error) {
  receipt.outcome = 'failed-control'
  receipt.errors.push(error.stack)
  if (win) {
    receipt.ledger = await win.evaluate(() => window.gg.invoke('runs.list', {})).catch(() => null)
    receipt.contacts = await win.evaluate(() => window.gg.invoke('contacts.list', {})).catch(() => null)
    receipt.screenshot = path.join(out, 'failure.png')
    await win.screenshot({ path: receipt.screenshot }).catch(() => {})
  }
  process.exitCode = 1
} finally {
  if (app) await app.close()
  server.close()
  unlinkSync(path.join(data, 'gg-config.json'))
  receipt.temporaryCredentialRemoved = true
  receipt.requests = requests
  receipt.asarSha256 = createHash('sha256').update(readFileSync(path.join(appPath, 'Contents/Resources/app.asar'))).digest('hex')
  receipt.finishedAt = new Date().toISOString()
  writeFileSync(path.join(out, 'receipt.json'), JSON.stringify(receipt, null, 2))
  console.log(JSON.stringify({ outcome: receipt.outcome, elapsedMs: receipt.elapsedMs, requests: requests.length, errors: receipt.errors }, null, 2))
}
