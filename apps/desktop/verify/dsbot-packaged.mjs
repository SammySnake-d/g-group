// Exercise the actual packaged binary, never the Vite renderer or a mock IPC.
// The fake mind is an explicit wiring control, NOT acceptance of real replies.
import { _electron as electron, expect } from '@playwright/test'
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, statSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'

const opt = (flag, fallback) => { const i = process.argv.indexOf(flag); return i < 0 ? fallback : process.argv[i + 1] }
const appPath = path.resolve(opt('--app', 'release/mac-arm64/g-group.app'))
const out = path.resolve(opt('--out', '/tmp/dsbot-astra-20261117/packaged-r2'))
mkdirSync(out, { recursive: true })
const data = mkdtempSync(path.join(os.tmpdir(), 'dsbot-package-control-'))
const owner = process.env.GG_CREDENTIAL_OWNER || path.join(os.homedir(), '.claude/settings.json')
const stored = JSON.parse(readFileSync(owner, 'utf8'))
const gateway = stored.gateway || { baseUrl: stored.env?.ANTHROPIC_BASE_URL, token: stored.env?.ANTHROPIC_AUTH_TOKEN }
if (!gateway.baseUrl || !gateway.token) throw new Error('本机配置 owner 不完整')
const model = 'fengshao1227/deepseek-v4.1-flash'
const receipt = { appPath, mode: 'real packaged host + fake mind control', realModelAcceptance: false, credentialOwner: owner, userData: data, model, startedAt: new Date().toISOString(), checks: [], errors: [], screenshots: [] }
let app, win
const check = (name, detail = {}) => { receipt.checks.push({ name, ...detail }); console.log(`已验证：${name}`) }
const shot = async name => { const file = path.join(out, `${name}.png`); await win.screenshot({ path: file }); receipt.screenshots.push(file) }
const env = { ...process.env, GG_USER_DATA_DIR: data, GG_BACKEND: 'server', GG_MIND: '', GG_COMPUTE: 'fake', GG_UPDATE_AUTO: 'off', GG_DEV_URL: '', ELECTRON_RUN_AS_NODE: '' }
const launch = async () => {
  app = await electron.launch({ executablePath: path.join(appPath, 'Contents/MacOS/g-group'), args: ['--lang=zh-CN'], env })
  win = await app.firstWindow()
  win.setDefaultTimeout(12_000)
  win.on('pageerror', error => receipt.errors.push(error.message))
  await win.locator('.dsb-frame').waitFor()
}
try {
  await launch()
  const initial = await win.evaluate(() => window.ggApp.invoke('setup.get', {}))
  if (!initial.ok || initial.value.backend.state !== 'needs-setup') throw new Error('全新配置没有显示未接入状态')
  check('新安装未配置时不使用演示后端', { backend: initial.value.backend })
  await win.getByRole('button', { name: '账户', exact: true }).click()
  await win.getByRole('menuitem', { name: '模型和 API Key', exact: true }).click()
  await win.getByRole('button', { name: '添加服务商', exact: true }).click()
  await win.getByRole('textbox', { name: '服务商 ID', exact: true }).fill('fengshao-gateway')
  await win.getByRole('textbox', { name: '名字', exact: true }).fill('fengshao 网关')
  await win.getByRole('textbox', { name: '接口地址', exact: true }).fill(gateway.baseUrl)
  await win.getByRole('textbox', { name: 'API key', exact: true }).fill(gateway.token)
  await win.getByRole('button', { name: '获取模型列表', exact: true }).click()
  await win.getByRole('button', { name: model, exact: true }).click({ timeout: 20_000 })
  check('从真实网关目录选择指定模型')
  await win.getByRole('button', { name: '添加', exact: true }).click()
  await expect.poll(() => { try { return JSON.parse(readFileSync(path.join(data, 'gg-config.json'), 'utf8')).gateway?.model } catch { return null } }).toBe(model)
  const config = JSON.parse(readFileSync(path.join(data, 'gg-config.json'), 'utf8'))
  if (config.gateway.token !== gateway.token) throw new Error('保存的令牌不一致')
  check('原版设置页保存网关', { configMode: (statSync(path.join(data, 'gg-config.json')).mode & 0o777).toString(8), tokenResolved: true })
  const connected = await win.evaluate(() => window.gg.invoke('session.hello', { clientApiVersion: window.gg.apiVersion }))
  if (!connected.ok) throw new Error('设置保存后同一窗口仍未连接后端')
  check('未重启窗口即连接真实宿主（尚无联系人、没有生成请求）')
  await app.close(); app = null
  env.GG_MIND = 'fake'
  await launch()
  const setup = await win.evaluate(() => window.ggApp.invoke('setup.get', {}))
  if (!setup.ok || setup.value.gateway?.model !== model || !setup.value.gateway?.hasToken) throw new Error('重启后未读取网关')
  check('重启读取网关模型与令牌存在位', { backend: setup.value.backend })

  for (const name of ['验收主联系人', '验收同伴']) {
    await win.getByRole('button', { name: '新建', exact: true }).click()
    await win.getByRole('option', { name: '新建 Bot', exact: true }).click()
    await win.getByRole('textbox', { name: '名字', exact: true }).fill(name)
    await win.getByRole('button', { name: '创建', exact: true }).click()
    await win.locator('[data-bot-id]').filter({ hasText: name }).first().waitFor()
    await win.keyboard.press('Escape')
    check(`通过原版表单创建 ${name}`)
  }
  await win.locator('[data-bot-id]').filter({ hasText: '验收主联系人' }).first().click()
  await win.locator('.dsb-composer textarea').fill('接线控制：请回复收到。')
  await win.getByRole('button', { name: '发送', exact: true }).click()
  await expect(win.locator('.dsb-flow .bt-bubble').first()).toBeVisible({ timeout: 20_000 })
  await shot('dm-fake-control')
  check('私聊发送与回复持久化（明确 fake 控制）')

  await win.getByRole('button', { name: '新建', exact: true }).click()
  await win.getByRole('option', { name: '新建群聊', exact: true }).click()
  await win.getByRole('option').filter({ hasText: '验收主联系人' }).click()
  await win.getByRole('option').filter({ hasText: '验收同伴' }).click()
  await win.getByRole('button', { name: '新建群聊', exact: true }).click()
  await win.locator('.dsb-composer textarea').fill('@验收主联系人 群聊接线控制，请回复。')
  await win.getByRole('button', { name: '发送', exact: true }).click()
  await expect(win.locator('.dsb-flow .bt-bubble').first()).toBeVisible({ timeout: 20_000 })
  await shot('group-fake-control')
  check('原版建群与群聊回复（明确 fake 控制，无管理员权限）')
  if (await win.getByText('管理员', { exact: true }).count()) throw new Error('群聊仍展示不存在的管理员权限')

  if (process.argv.includes('--attachments')) {
    // Use native macOS clipboard + Command+V, retaining all pre-existing formats.
    const image = await win.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = 240; canvas.height = 100
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#ebf2ff'; ctx.fillRect(0, 0, 240, 100)
      ctx.fillStyle = '#2165f5'; ctx.font = '24px sans-serif'; ctx.fillText('g-group', 25, 60)
      return canvas.toDataURL('image/png').split(',')[1]
    })
    await app.evaluate(({ clipboard, nativeImage }, base64) => {
      globalThis.__ggSavedClipboard = clipboard.availableFormats().map(format => [format, clipboard.readBuffer(format)])
      clipboard.writeImage(nativeImage.createFromBuffer(Buffer.from(base64, 'base64')))
    }, image)
    try {
      await win.locator('.dsb-composer textarea').focus()
      await win.keyboard.press('Meta+V')
      await expect(win.getByLabel('待发送附件').locator('img')).toBeVisible()
      await shot('image-pending-native-paste')
    } finally {
      await app.evaluate(({ clipboard }) => { clipboard.clear(); for (const [format, buffer] of globalThis.__ggSavedClipboard || []) clipboard.writeBuffer(format, buffer); delete globalThis.__ggSavedClipboard })
    }
    await win.getByRole('button', { name: '发送', exact: true }).click()
    const imageButton = win.getByRole('button', { name: /^打开图片 / }).last()
    await expect(imageButton).toBeVisible()
    await expect(win.locator('.dsb-pending')).toHaveCount(0)
    await expect(win.getByRole('button', { name: /^打开图片 / })).toHaveCount(1)
    await imageButton.click()
    await expect(win.getByRole('dialog', { name: '查看图片' })).toBeVisible()
    await shot('image-lightbox')
    await win.keyboard.press('Escape')
    await expect(win.getByRole('dialog', { name: '查看图片' })).toHaveCount(0)
    check('真实打包版原生粘贴图片 → 待发 → 发送 → 原版图片查看器 → Escape')

    const textFile = Buffer.from('g-group 附件下载逐字校验\n第二行\n', 'utf8')
    const wav = Buffer.alloc(44 + 8000 * 2)
    wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16)
    wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28)
    wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40)
    for (let i = 0; i < 8000; i++) wav.writeInt16LE(Math.round(Math.sin(i * Math.PI * 2 * 440 / 8000) * 1000), 44 + i * 2)
    const chooser = win.waitForEvent('filechooser')
    await win.locator('.dsb-composer-tools').getByRole('button', { name: '添加', exact: true }).click()
    await win.getByRole('menuitem', { name: '添加文件', exact: true }).click()
    await (await chooser).setFiles([{ name: '接线说明.txt', mimeType: 'text/plain', buffer: textFile }, { name: '语音样本.wav', mimeType: 'audio/wav', buffer: wav }])
    await expect(win.getByLabel('待发送附件').locator('.gg-pending-item')).toHaveCount(2)
    await win.locator('.dsb-composer textarea').fill('附件说明：\n- 文本文件\n- 语音样本\n\n```js\nconst attached = true\n```')
    await win.getByRole('button', { name: '发送', exact: true }).click()
    // Electron's native session owns downloads; Playwright Page.download does
    // not report them. Observe that real event and choose an isolated save dir.
    const downloadsDir = path.join(out, 'downloads'); mkdirSync(downloadsDir, { recursive: true })
    await app.evaluate(({ BrowserWindow }, dir) => {
      globalThis.__ggDownloads = []
      BrowserWindow.getAllWindows()[0].webContents.session.on('will-download', (_event, item) => {
        const entry = { filename: item.getFilename(), savePath: `${dir}/${item.getFilename()}`, state: 'started' }
        globalThis.__ggDownloads.push(entry)
        item.setSavePath(entry.savePath)
        item.once('done', (_event, state) => { entry.state = state })
      })
    }, downloadsDir)
    await win.getByRole('button', { name: '下载 接线说明.txt', exact: true }).last().click()
    await expect.poll(() => app.evaluate(() => globalThis.__ggDownloads.find(item => item.filename === '接线说明.txt')?.state)).toBe('completed')
    const download = await app.evaluate(() => globalThis.__ggDownloads.find(item => item.filename === '接线说明.txt'))
    const downloadedBytes = readFileSync(download.savePath)
    if (!downloadedBytes.equals(textFile)) throw new Error('下载文件与原始内容不一致')
    await expect(win.locator('.gg-audio audio')).toBeVisible()
    await expect.poll(() => win.locator('.gg-audio audio').last().evaluate(audio => audio.readyState)).toBeGreaterThan(0)
    const voice = await win.locator('.gg-audio audio').last().evaluate(async audio => { await audio.play(); const playing = !audio.paused; audio.pause(); return { playing, paused: audio.paused, duration: audio.duration } })
    if (!voice.playing || !voice.paused || voice.duration !== 1) throw new Error('语音条播放/暂停未通过')
    await expect(win.locator('.dsb-pending')).toHaveCount(0)
    await expect(win.locator('.md_markdown li')).toHaveCount(2)
    const contrast = await win.locator('.gg-audio').evaluate(node => ({ color: getComputedStyle(node).color, bubbleInk: getComputedStyle(node.closest('.bt-ububble')).color }))
    if (contrast.color !== contrast.bubbleInk) throw new Error('用户气泡内的附件标题没有沿用可读字色')
    await app.evaluate(({ clipboard }) => { globalThis.__ggSavedClipboard = clipboard.availableFormats().map(format => [format, clipboard.readBuffer(format)]) })
    try {
      await win.locator('.md-code').last().hover()
      await win.locator('.md-copy').last().click()
      await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText().trim())).toBe('const attached = true')
      const readDenied = await win.evaluate(async () => {
        try { await navigator.clipboard.readText(); return false } catch (error) { return error.name === 'NotAllowedError' }
      })
      if (!readDenied) throw new Error('复制修复意外开放了页面读取系统剪贴板')
    } finally {
      await app.evaluate(({ clipboard }) => { clipboard.clear(); for (const [format, buffer] of globalThis.__ggSavedClipboard || []) clipboard.writeBuffer(format, buffer); delete globalThis.__ggSavedClipboard })
    }
    await shot('file-audio-markdown')
    check('原版文件卡片、完整下载、语音条播放暂停、Markdown 列表/代码复制', { nativeDownload: download, bytes: downloadedBytes.length, sha256: createHash('sha256').update(downloadedBytes).digest('hex'), voice, contrast, clipboardWrite: 'native text matched', clipboardRead: 'denied', optimisticPendingAfterSend: 0 })
    await win.locator('.dsb-composer input[type=file]').setInputFiles({ name: '超限文件.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(16 * 1024 * 1024 + 1) })
    await expect(win.getByRole('alert').filter({ hasText: '16 MiB' })).toBeVisible()
    await expect(win.getByLabel('待发送附件')).toHaveCount(0)
    check('超限附件明确拒绝，不发送或显示截断文件为成功')
  }
  const state = await win.evaluate(async () => {
    const contacts = await window.gg.invoke('contacts.list', {})
    const rooms = await window.gg.invoke('rooms.list', {})
    return { contacts, rooms }
  })
  receipt.persisted = state
  await app.close(); app = null
  await launch()
  const rooms = await win.evaluate(() => window.gg.invoke('rooms.list', {}))
  if (!rooms.ok || !rooms.value.rooms.some(room => room.kind === 'group')) throw new Error('重启后群不在')
  check('打包版重启后联系人、群与聊天记录仍可读取')
  receipt.outcome = 'passed-control-not-real-model'
} catch (error) {
  receipt.outcome = 'failed'
  receipt.error = error.stack
  if (win) { await shot('failure').catch(() => {}); receipt.failureText = await win.locator('body').innerText().catch(() => '') }
  console.error(error.message.replaceAll(gateway.token, '[REDACTED]'))
  process.exitCode = 1
} finally {
  if (app) await app.close().catch(() => {})
  // The disposable control profile must not retain the user's reusable secret.
  try { unlinkSync(path.join(data, 'gg-config.json')); receipt.temporaryCredentialRemoved = true } catch {}
  receipt.asarSha256 = createHash('sha256').update(readFileSync(path.join(appPath, 'Contents/Resources/app.asar'))).digest('hex')
  receipt.finishedAt = new Date().toISOString()
  writeFileSync(path.join(out, 'receipt.json'), JSON.stringify(receipt, null, 2).replaceAll(gateway.token, '[REDACTED]'))
}
