import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { _electron as electron, expect, test, type Page } from '@playwright/test'

// PR #101 R2：只操作真实 Electron 界面；宿主/SQLite 是真的，模型回复用显式替身。
const appDir = path.resolve(import.meta.dirname, '..')
const env = Object.fromEntries(Object.entries(process.env).filter(([k, v]) => k !== 'ELECTRON_RUN_AS_NODE' && !k.startsWith('ANTHROPIC_') && typeof v === 'string')) as Record<string, string>
const LONG = { timeout: 30_000 }
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64')
const image = (name: string) => ({ name, mimeType: 'image/png', buffer: png })
async function launch(ud: string) {
  const app = await electron.launch({ args: [appDir], cwd: appDir, env: { ...env, GG_BACKEND: 'server', GG_MIND: 'fake', GG_COMPUTE: 'fake', GG_USER_DATA_DIR: ud, GG_UPDATE_AUTO: 'off' } })
  const win = await app.firstWindow()
  await expect(win.getByTestId('backend-demo')).toHaveAttribute('data-wire', 'live', LONG)
  return { app, win }
}
async function addContact(win: Page, name: string) {
  await win.getByTestId('nav-contacts').click()
  await win.getByTestId('list').getByText('添加联系人', { exact: true }).click()
  await win.getByPlaceholder('比如：设计师').fill(name)
  await win.getByRole('button', { name: '添加', exact: true }).click()
  await expect(win.getByTestId('chat').locator('header')).toContainText(name, LONG)
}
const mine = (win: Page) => win.getByTestId('chat-column').locator('[data-msg][data-from="me"]')
const pending = (win: Page) => win.getByTestId('composer-images').locator('[data-pending-image]')
async function pickModel(win: Page, id: string, label: string) {
  await win.getByTestId(id).getByRole('combobox').click()
  await win.getByRole('option', { name: label, exact: true }).click()
}

test('图片粘贴先进待发区、不发消息；逐张删除后只留下另一张', async () => {
  const ud = mkdtempSync(path.join(tmpdir(), 'gg-pr101-paste-'))
  const { app, win } = await launch(ud)
  try {
    await addContact(win, '图片联系人')
    const before = await mine(win).count()
    await app.evaluate(({ clipboard, nativeImage }, b64) => clipboard.writeImage(nativeImage.createFromBuffer(Buffer.from(b64, 'base64'))), png.toString('base64'))
    await win.getByTestId('composer').press('Meta+V')
    await expect(pending(win)).toHaveCount(1)
    await expect(pending(win).locator('img')).toBeVisible()
    await expect(mine(win)).toHaveCount(before)
    await win.getByTestId('image-input').setInputFiles(image('second.png'))
    await expect(pending(win)).toHaveCount(2)
    await pending(win).first().getByRole('button', { name: /移除/ }).click()
    await expect(pending(win)).toHaveCount(1)
    await expect(pending(win).locator('img')).toHaveAttribute('alt', 'second.png')
    await expect(mine(win)).toHaveCount(before)
    await expect(win.getByTestId('send')).toBeEnabled()
  } finally { await app.close(); rmSync(ud, { recursive: true, force: true }) }
})

test('图片草稿按会话保存，切走和重启不丢；纯图也能回车发送', async () => {
  test.setTimeout(90_000)
  const ud = mkdtempSync(path.join(tmpdir(), 'gg-pr101-draft-'))
  let run = await launch(ud)
  try {
    await addContact(run.win, '图片甲')
    await run.win.getByTestId('image-input').setInputFiles(image('draft.png'))
    await expect(pending(run.win)).toHaveCount(1)
    await expect(run.win.getByTestId('composer-images')).toHaveAttribute('data-saved', 'true')
    await addContact(run.win, '图片乙')
    await expect(run.win.getByTestId('composer-images')).toHaveCount(0)
    await run.win.getByTestId('list').locator('[data-testid^="conv-dm-"]').filter({ hasText: '图片甲' }).click()
    await expect(pending(run.win)).toHaveCount(1)
    await run.app.close()
    run = await launch(ud)
    await run.win.getByTestId('list').locator('[data-testid^="conv-dm-"]').filter({ hasText: '图片甲' }).click()
    await expect(pending(run.win).locator('img')).toHaveAttribute('alt', 'draft.png')
    await run.win.getByTestId('composer').press('Enter')
    await expect(mine(run.win).locator('[data-testid="attachment-draft.png"] img')).toBeVisible(LONG)
    await expect(run.win.getByTestId('composer-images')).toHaveCount(0)
    await expect(mine(run.win)).toHaveCount(1)
  } finally { await run.app.close(); rmSync(ud, { recursive: true, force: true }) }
})

test('多图和文字只发一条消息，聊天缩略图点击原地放大、关闭回到原聊天，重启仍能查看', async () => {
  test.setTimeout(90_000)
  const ud = mkdtempSync(path.join(tmpdir(), 'gg-pr101-preview-'))
  let run = await launch(ud)
  try {
    await addContact(run.win, '图片预览')
    await run.win.getByTestId('image-input').setInputFiles([image('first.png'), image('second.png')])
    await expect(pending(run.win)).toHaveCount(2)
    await run.win.getByTestId('composer').fill('这两张一起发送')
    await run.win.getByTestId('send').click()
    await expect(mine(run.win)).toHaveCount(1, LONG)
    await expect(mine(run.win)).toContainText('这两张一起发送')
    await expect(mine(run.win).locator('[data-testid^="attachment-"] img')).toHaveCount(2)
    await run.win.getByTestId('attachment-first.png').click()
    await expect(run.win.getByTestId('image-preview')).toBeVisible()
    await expect(run.win.getByTestId('image-preview').locator('img')).toHaveJSProperty('naturalWidth', 1)
    await expect(run.win.getByTestId('chat-column')).toBeVisible()
    await expect(run.win.getByTestId('files-main')).toHaveCount(0)
    await run.win.getByRole('button', { name: '关闭图片预览' }).click()
    await expect(run.win.getByTestId('image-preview')).toHaveCount(0)
    await expect(run.win.getByTestId('chat-title')).toContainText('图片预览')
    await run.app.close()
    run = await launch(ud)
    await run.win.getByTestId('list').locator('[data-testid^="conv-dm-"]').filter({ hasText: '图片预览' }).click()
    await expect(run.win.getByTestId('composer-images')).toHaveCount(0)
    await expect(run.win.getByTestId('attachment-second.png').locator('img')).toBeVisible(LONG)
    await run.win.getByTestId('attachment-second.png').click()
    await expect(run.win.getByTestId('image-preview').locator('img')).toHaveJSProperty('naturalWidth', 1)
    await run.win.keyboard.press('Escape')
    await expect(run.win.getByTestId('image-preview')).toHaveCount(0)
  } finally { await run.app.close(); rmSync(ud, { recursive: true, force: true }) }
})

test('设置模型来自网关、当前值保留且选中，单独换说话模型后重启仍保存，新联系人使用新值', async () => {
  test.setTimeout(90_000)
  const requests: string[] = []
  const server = createServer((req, res) => {
    requests.push(req.url ?? '')
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ data: [{ id: 'fixture/second', name: '网关第二个模型' }] }))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const ud = mkdtempSync(path.join(tmpdir(), 'gg-pr101-models-'))
  writeFileSync(path.join(ud, 'gg-config.json'), JSON.stringify({ gateway: { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, model: 'fixture/current', token: 'NEUTRAL_FIXTURE_NO_CREDENTIALS' } }), { mode: 0o600 })
  let run = await launch(ud)
  try {
    await run.win.getByTestId('nav-settings').click()
    await expect(run.win.getByTestId('def-talk')).toContainText('fixture/current', LONG)
    await expect(run.win.getByTestId('def-compute')).toContainText('fixture/current')
    await pickModel(run.win, 'def-talk', '网关第二个模型')
    await expect(run.win.getByTestId('defaults-save')).toBeEnabled()
    await run.win.getByTestId('defaults-save').click()
    await expect(run.win.getByTestId('defaults-saved')).toBeVisible(LONG)
    await run.app.close()
    run = await launch(ud)
    await run.win.getByTestId('nav-settings').click()
    await expect(run.win.getByTestId('def-talk')).toContainText('网关第二个模型', LONG)
    await expect(run.win.getByTestId('def-compute')).toContainText('fixture/current')
    await addContact(run.win, '换模后新联系人')
    await run.win.getByTestId('composer').fill('你好')
    await run.win.getByTestId('send').click()
    await expect(run.win.getByTestId('chat-column')).toContainText('收到', LONG)
    expect(requests).toContain('/v1/models')
  } finally { await run.app.close(); server.close(); rmSync(ud, { recursive: true, force: true }) }
})

test('目录读取失败时保留当前模型，禁用换模并说清原因，不填演示目录', async () => {
  test.setTimeout(60_000)
  const ud = mkdtempSync(path.join(tmpdir(), 'gg-pr101-catalog-fail-'))
  writeFileSync(path.join(ud, 'gg-config.json'), JSON.stringify({ gateway: { baseUrl: 'http://127.0.0.1:9', model: 'fixture/retained', token: 'NEUTRAL_FIXTURE_NO_CREDENTIALS' } }), { mode: 0o600 })
  const { app, win } = await launch(ud)
  try {
    await win.getByTestId('nav-settings').click()
    await expect(win.getByTestId('model-catalog-error')).toContainText('模型目录', LONG)
    await expect(win.getByTestId('def-talk')).toContainText('fixture/retained')
    await expect(win.getByTestId('def-talk').getByRole('combobox')).toHaveAttribute('aria-disabled', 'true')
    await expect(win.getByTestId('model-defaults')).not.toContainText('Claude Opus 5.5')
    await expect(win.getByTestId('model-catalog-error')).toContainText('模型接入')
  } finally { await app.close(); rmSync(ud, { recursive: true, force: true }) }
})
