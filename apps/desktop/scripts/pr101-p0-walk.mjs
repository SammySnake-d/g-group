#!/usr/bin/env node
// 打包版 P0 实点；令牌从用户已配置的本地 gg-config.json 读入，仅用于隔离的验收 profile。
// node scripts/pr101-p0-walk.mjs <app二进制> <输出目录> <现有gg-config.json>
// 不复制含密钥的配置/数据库到证据目录；输出只含模型、步骤、截图和产物 hash。
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { _electron: electron, expect } = require('@playwright/test')
const [binary, output, configOwner, resumeFrom] = process.argv.slice(2)
if (!binary || !output || !configOwner) throw new Error('需要二进制、输出目录、现有配置所有者路径')
const out = path.resolve(output)
mkdirSync(out, { recursive: true })
const gateway = JSON.parse(readFileSync(configOwner, 'utf8')).gateway
const model = 'fengshao1227/deepseek-v4.1-flash'
if (!gateway?.token || !gateway.baseUrl.includes('127.0.0.1:3425')) throw new Error('配置未解析到指定的本机网关')
const prior = resumeFrom ? JSON.parse(readFileSync(resumeFrom, 'utf8')) : null
const ud = prior?.userData ?? mkdtempSync(path.join(tmpdir(), 'gg-pr101-r2-packaged-'))
const desktop = path.resolve(import.meta.dirname, '..')
const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: desktop, encoding: 'utf8' }).trim()
const result = { head, binary, model, gateway: gateway.baseUrl, userData: ud, steps: [], pageErrors: [], package: {} }
if (prior) {
  result.previousResult = path.resolve(resumeFrom)
  result.steps = prior.steps.slice(0, 7).map((s) => ({ ...s, screenshot: path.relative(out, path.resolve(path.dirname(resumeFrom), s.screenshot)) }))
  result.package = prior.package
}
const env = Object.fromEntries(Object.entries(process.env).filter(([k, v]) => !['ELECTRON_RUN_AS_NODE', 'GG_MIND', 'GG_DATA_DIR', 'GG_REVIEW_TOKEN'].includes(k) && !k.startsWith('ANTHROPIC_') && typeof v === 'string'))
let app, win
const save = () => writeFileSync(path.join(out, 'result.json'), JSON.stringify(result, null, 2) + '\n')
let n = prior ? 7 : 0
const step = async (name, fn) => {
  const start = Date.now()
  const row = { name, ok: false }
  try { row.note = await fn(); row.ok = true; console.log('通过', name) }
  catch (e) { row.error = String(e.message).slice(0, 1000); console.log('失败', name, row.error) }
  row.ms = Date.now() - start
  row.screenshot = `${String(++n).padStart(2, '0')}-${name}.png`
  await win.screenshot({ path: path.join(out, row.screenshot) }).catch(() => {})
  result.steps.push(row); save()
  if (!row.ok) throw new Error(name + ' 未通过')
}
const LONG = { timeout: 30_000 }
const launch = async () => {
  app = await electron.launch({ executablePath: binary, env: { ...env, GG_USER_DATA_DIR: ud, GG_UPDATE_AUTO: 'off', GG_COMPUTE: 'fake' } })
  win = await app.firstWindow()
  win.on('pageerror', (e) => result.pageErrors.push(e.message))
  await win.waitForLoadState('domcontentloaded')
}
const closeSettings = async () => { if (await win.getByTestId('scrim').count()) { await win.keyboard.press('Escape'); await expect(win.getByTestId('scrim')).toHaveCount(0) } }
const add = async (name) => {
  await closeSettings()
  await win.getByTestId('nav-contacts').click()
  await win.getByTestId('list').getByText('添加联系人', { exact: true }).click()
  await win.getByPlaceholder('比如：设计师').fill(name)
  await expect(win.getByTestId('add-model-note')).toContainText(model)
  await win.getByRole('button', { name: '添加', exact: true }).click()
  await expect(win.getByTestId('chat').locator('header')).toContainText(name, LONG)
}
const column = () => win.getByTestId('chat-column')
const own = () => column().locator('[data-msg][data-from="me"]')
const pending = () => win.getByTestId('composer-images').locator('[data-pending-image]')
const send = async (text) => { await win.getByTestId('composer').fill(text); await win.getByTestId('composer').press('Enter') }
const reply = async (marker, expectedFrom) => {
  const selector = expectedFrom ? `[data-msg][data-from="${expectedFrom}"]` : '[data-msg]:not([data-from="me"]):not([data-testid^="replying-"])'
  const rows = column().locator(selector).filter({ hasText: marker })
  await expect(rows.first()).toBeVisible({ timeout: 360_000 })
  return { text: (await rows.first().innerText()).slice(0, 300), from: await rows.first().getAttribute('data-from') }
}
try {
  await launch()
  if (!prior) {
  await step('首次接入', async () => {
    const info = await app.evaluate(({ app }) => ({ packaged: app.isPackaged, version: app.getVersion(), appPath: app.getAppPath() }))
    if (!info.packaged) throw new Error('需要真正的打包版')
    const asar = info.appPath
    result.package = { ...info, sha256: createHash('sha256').update(readFileSync(asar)).digest('hex') }
    await expect(win.getByTestId('setup-screen')).toBeVisible(LONG)
    await win.getByTestId('setup-base-url').fill(gateway.baseUrl)
    await win.getByTestId('setup-token').fill(gateway.token)
    await win.getByTestId('setup-model').fill(model)
    await win.getByTestId('setup-save').click()
    await expect(win.getByTestId('backend-demo')).toHaveAttribute('data-wire', 'live', LONG)
    return '模型和令牌经应用表单保存；宿主 live；真实联系人脑子未设 fake'
  })
  await step('真实模型目录及当前值', async () => {
    await win.getByTestId('nav-settings').click()
    await expect(win.getByTestId('def-talk')).toHaveText(model, LONG)
    await expect(win.getByTestId('def-compute')).toHaveText(model)
    await win.getByTestId('def-talk').click()
    const selected = win.getByRole('option', { name: model, exact: true })
    await expect(selected).toHaveAttribute('aria-selected', 'true')
    const labels = await win.getByRole('option').allTextContents()
    await win.keyboard.press('Escape')
    await closeSettings()
    return { count: labels.length, selected: model, sameProvider: labels.filter((s) => s.startsWith('fengshao1227/')), alternateInference: '未执行：用户仅指定这一个真实回复模型；另一模型写入及重启由 pr101-p0.electron.spec.ts 的受控网关验证' }
  })
  await step('添加联系人及私聊真实回复', async () => { await add('小克'); await send('请只回复这六个字符:DM_OK1,不要做别的事。'); return reply('DM_OK1') })
  await step('粘贴两图逐张删除', async () => {
    const source = path.join(out, 'clipboard-source.png')
    await win.screenshot({ path: source, clip: { x: 0, y: 0, width: 320, height: 200 } })
    await app.evaluate(({ clipboard, nativeImage }, p) => clipboard.writeImage(nativeImage.createFromPath(p)), source)
    const before = await own().count()
    await win.getByTestId('composer').press('Meta+V')
    await expect(pending()).toHaveCount(1)
    await win.getByTestId('tool-shot').click()
    await expect(pending()).toHaveCount(2)
    await expect(own()).toHaveCount(before)
    await pending().first().getByRole('button', { name: /移除/ }).click()
    await expect(pending()).toHaveCount(1)
    await expect(own()).toHaveCount(before)
    await expect(win.getByTestId('composer-images')).toHaveAttribute('data-saved', 'true')
    return '系统剪贴板+工具栏截图均先待发；移除一张后消息数不变'
  })
  await step('切会话与重启图片草稿保持', async () => {
    await add('小林')
    await expect(win.getByTestId('composer-images')).toHaveCount(0)
    await win.getByTestId('list').locator('[data-testid^="conv-dm-"]').filter({ hasText: '小克' }).click()
    await expect(pending()).toHaveCount(1)
    await app.close(); await launch()
    await expect(win.getByTestId('backend-demo')).toHaveAttribute('data-wire', 'live', LONG)
    await win.getByTestId('list').locator('[data-testid^="conv-dm-"]').filter({ hasText: '小克' }).click()
    await expect(pending()).toHaveCount(1)
    return '客户端 profile 中持久保存，切会话和重启后图仍在待发区'
  })
  await step('发送后聊天缩略图', async () => {
    await win.getByTestId('composer').fill('这是一张截图，后续无需回复。')
    await win.getByTestId('send').click()
    await expect(win.getByTestId('composer-images')).toHaveCount(0, LONG)
    const sent = own().filter({ hasText: '这是一张截图' })
    await expect(sent).toHaveCount(1)
    await expect(sent.locator('[data-testid^="attachment-"] img')).toBeVisible(LONG)
    return '图文在同一条消息中，聊天显示真实图片缩略图'
  })
  await step('聊天原地放大及关闭', async () => {
    await own().filter({ hasText: '这是一张截图' }).locator('[data-testid^="attachment-"]').click()
    const preview = win.getByTestId('image-preview')
    await expect(preview).toBeVisible()
    const dimensions = await preview.locator('img').evaluate((e) => ({ width: e.naturalWidth, height: e.naturalHeight, complete: e.complete }))
    if (!dimensions.width || !dimensions.complete) throw new Error('预览图未加载')
    await expect(column()).toBeVisible()
    await expect(win.getByTestId('files-main')).toHaveCount(0)
    await win.screenshot({ path: path.join(out, '07a-聊天原地放大.png') })
    await win.getByRole('button', { name: '关闭图片预览' }).click()
    await expect(preview).toHaveCount(0)
    await expect(win.getByTestId('chat').locator('header')).toContainText('小克')
    return dimensions
  })
  } else {
    // 复用已验完的七步和同一个 profile，只补目标联系人的真实回执。
    await win.getByTestId('setup-base-url').fill(gateway.baseUrl)
    await win.getByTestId('setup-token').fill(gateway.token)
    await win.getByTestId('setup-model').fill(model)
    await win.getByTestId('setup-save').click()
    await expect(win.getByTestId('backend-demo')).toHaveAttribute('data-wire', 'live', LONG)
    await win.getByTestId('list').locator('[data-testid^="conv-g-"]').filter({ hasText: 'P0打包验收群' }).click()
    // 补留真正打开大图时的截图；不重发已经完成的图片消息。
    await win.getByTestId('list').locator('[data-testid^="conv-dm-"]').filter({ hasText: '小克' }).click()
    await own().filter({ hasText: '这是一张截图' }).locator('[data-testid^="attachment-"]').click()
    await expect(win.getByTestId('image-preview')).toBeVisible(LONG)
    await win.screenshot({ path: path.join(out, '07a-聊天原地放大.png') })
    await win.getByRole('button', { name: '关闭图片预览' }).click()
    await win.getByTestId('list').locator('[data-testid^="conv-g-"]').filter({ hasText: 'P0打包验收群' }).click()
  }
  await step('建群及指定联系人真实回复', async () => {
    if (!prior) {
    await win.getByTestId('nav-contacts').click()
    await win.getByTestId('list').getByText('发起群聊', { exact: true }).click()
    await win.getByLabel('群名').fill('P0打包验收群')
    for (const name of ['小克', '小林']) await win.locator('label').filter({ hasText: name }).getByRole('checkbox').click()
    await win.getByRole('button', { name: '创建群聊（3 人）' }).click()
    await expect(win.getByTestId('chat-title')).toContainText('P0打包验收群')
    }
    const target = await win.evaluate(async () => {
      const r = await window.gg.invoke('contacts.list', {})
      if (!r.ok) throw new Error('联系人列表没读到')
      return r.value.contacts.find((p) => p.name === '小林')?.id
    })
    if (!target) throw new Error('没找到被点名的小林')
    const box = win.getByTestId('composer')
    const marker = prior ? 'TARGET_OK_3' : 'GRP_OK_2'
    await box.fill(`@小林 请只回复这些字符:${marker},不要做别的事。`)
    await box.press('Escape'); await box.press('Enter')
    const response = await reply(marker, target)
    const others = await column().locator('[data-msg]:not([data-from="me"]):not([data-testid^="replying-"])').filter({ hasText: marker }).evaluateAll((els) => els.map((e) => ({ from: e.getAttribute('data-from'), text: e.innerText.slice(0, 300) })))
    return { ...response, expectedFrom: target, observedReplies: others, routingScope: '确认为被点名的小林收到并给出真实回复；未点名者起回合/互相唤醒另由后端 #106 修复' }
  })
} catch (e) { result.error = String(e.message) }
finally {
  await app?.close().catch(() => {})
  // 含令牌的测试配置不留在临时目录中；只清本脚本自己建立的那一份。
  try { unlinkSync(path.join(ud, 'gg-config.json')) } catch {}
  save()
}
console.log(JSON.stringify({ passed: result.steps.filter((s) => s.ok).length, total: result.steps.length, pageErrors: result.pageErrors.length }))
process.exit(result.error || result.pageErrors.length ? 1 : 0)
