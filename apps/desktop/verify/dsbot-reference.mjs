#!/usr/bin/env node
// 运行冻结原版窗口源码；只用视觉夹具替换数据，不改渲染树和样式。
// node verify/dsbot-reference.mjs [--candidate http://127.0.0.1:5199] [--out /tmp/dsbot-astra-20261117]
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { createServer } from 'vite'
import { chromium } from '@playwright/test'
import { FIXTURE_AT, PREVIEW_SVG, installCandidateFixture, makeVisualFixture, originalFixtureCall } from './dsbot-visual-fixture.mjs'

const args = process.argv.slice(2)
const option = (name, fallback) => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1] }
const upstream = option('--upstream', '/tmp/ds-bot-feasibility-20261116/repo')
const original = option('--original', '/tmp/dsbot-original-20261117-astra')
const out = option('--out', '/tmp/dsbot-astra-20261117')
const candidateUrl = option('--candidate', '')
const fixture = makeVisualFixture()
mkdirSync(out, { recursive: true })
if (!existsSync(path.join(upstream, 'app/ui/src/main.js'))) throw new Error(`原版源不存在：${upstream}`)
if (!existsSync(path.join(original, 'node_modules/react-markdown'))) throw new Error(`先在 ${original} 安装 vite/react/react-dom/react-markdown/remark-gfm、deep-view、qrcode-generator 和 @deepseek-ai/dsh-client-ui-primitives 的实际运行依赖（含其 devDependencies 的 bare imports 及 zustand/immer）；不要装上游整套 DSH 后端。`)
for (const part of ['app/ui', 'ds-bot/src/client', 'ds-bot/src/shared']) cpSync(path.join(upstream, part), path.join(original, part), { recursive: true })
mkdirSync(path.join(original, 'app/src'), { recursive: true })
for (const name of ['fonts.css', 'macos.css', 'material.css', 'page-card.css']) cpSync(path.join(upstream, 'app/src', name), path.join(original, 'app/src', name))
cpSync(path.join(upstream, 'app/vite.config.js'), path.join(original, 'app/vite.config.js'))

const server = await createServer({ configFile: path.join(original, 'app/vite.config.js'), server: { host: '127.0.0.1', port: 5206, strictPort: true }, logLevel: 'warn' })
await server.listen()
const browser = await chromium.launch({ headless: true })
const hash = filename => createHash('sha256').update(readFileSync(filename)).digest('hex')
const sourceHashes = {}
for (const dir of ['app/ui/src', 'ds-bot/src/client', 'ds-bot/src/shared']) {
  for (const entry of readdirSync(path.join(upstream, dir), { withFileTypes: true })) {
    if (entry.isFile()) sourceHashes[`${dir}/${entry.name}`] = hash(path.join(upstream, dir, entry.name))
  }
}
for (const filename of ['app/ui/index.html', 'app/vite.config.js', ...['fonts.css', 'macos.css', 'material.css', 'page-card.css'].map(name => `app/src/${name}`)]) sourceHashes[filename] = hash(path.join(upstream, filename))
const dependencies = Object.fromEntries(['vite', 'react', 'react-dom', 'react-markdown', 'remark-gfm', '@deepseek-ai/dsh-client-ui-primitives', 'deep-view'].map(name => [name, JSON.parse(readFileSync(path.join(original, 'node_modules', name, 'package.json'), 'utf8')).version]))
const receipt = { fixture: fixture.note, upstream, frozenCommit: execFileSync('git', ['-C', upstream, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), sourceHashes, dependencies, viewport: { width: 1200, height: 800 }, locale: 'zh-CN', colorScheme: 'light', screenshots: [], errors: [], calls: [] }

async function capture(label, url, isCandidate) {
  const context = await browser.newContext({ viewport: receipt.viewport, deviceScaleFactor: 1, locale: receipt.locale, timezoneId: 'Asia/Shanghai', colorScheme: receipt.colorScheme, reducedMotion: 'reduce' })
  const page = await context.newPage()
  await page.clock.setFixedTime(new Date(FIXTURE_AT))
  await page.addInitScript(() => { Object.defineProperty(navigator, 'platform', { get: () => 'MacIntel' }) })
  if (isCandidate) await page.addInitScript(installCandidateFixture, JSON.parse(JSON.stringify(fixture)))
  await page.route('**/visual-fixture/preview.svg', route => route.fulfill({ status: 200, contentType: 'image/svg+xml', body: PREVIEW_SVG }))
  if (!isCandidate) {
    await page.route('**/api/bot/feed', route => route.fulfill({ status: 200, contentType: 'text/event-stream', body: 'event: hello\ndata: {}\n\n' }))
    await page.route('**/api/bot', async (route) => {
      const { endpoint, payload } = route.request().postDataJSON()
      receipt.calls.push({ label, endpoint, payload })
      try { await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, value: originalFixtureCall(fixture, endpoint, payload ?? {}) }) }) }
      catch (error) { await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: false, error: { code: 'bot/refused', message: error.message } }) }) }
    })
  }
  page.on('pageerror', error => receipt.errors.push({ label, error: error.message }))
  page.on('console', msg => { if (msg.type() === 'error') receipt.errors.push({ label, console: msg.text() }) })
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  if (!isCandidate) {
    // Electron 原版在 dom-ready 插入这四份宿主 CSS；浏览器基准同样插入其原始字节。
    for (const name of ['material.css', 'macos.css', 'fonts.css', 'page-card.css']) await page.addStyleTag({ content: readFileSync(path.join(original, 'app/src', name), 'utf8') })
  }
  await page.locator('[data-bot-id="contact-main"]').waitFor({ timeout: 30_000 })
  await page.locator('[data-bot-id="contact-main"]').first().click()
  await page.getByText('今天先完成三件事：', { exact: false }).waitFor({ timeout: 30_000 })
  await page.locator('.md_markdown img').first().waitFor({ timeout: 15_000 })
  await page.evaluate(async () => { await document.fonts.ready; await Promise.all([...document.images].map(img => img.complete ? undefined : new Promise(resolve => { img.onload = resolve; img.onerror = resolve }))) })
  const state = await page.evaluate(() => {
    const styles = selector => {
      const node = document.querySelector(selector)
      if (!node) return null
      const css = getComputedStyle(node)
      const box = node.getBoundingClientRect()
      return { color: css.color, background: css.backgroundColor, width: box.width, height: box.height, x: box.x, y: box.y }
    }
    return { title: document.title, language: document.documentElement.lang, mainCards: document.querySelectorAll('[data-bot-id="contact-main"]').length, listNames: [...document.querySelectorAll('[data-bot-id],[data-room-id]')].map(el => el.innerText), listItems: document.querySelectorAll('.md_markdown li').length, timeSeparators: document.querySelectorAll('.bt-time-sep').length, bodyText: document.body.innerText, fixtureCalls: window.__DSBOT_VISUAL_FIXTURE__?.calls, mainMargin: document.querySelector('.dsb-main')?.getAttribute('style'), sidebarWidth: document.querySelector('.bt-leftcol')?.getBoundingClientRect().width, computed: { userBubble: styles('.bt-ububble'), assistantBubble: styles('.bt-bubble'), composer: styles('.dsb-composer'), header: styles('.bt-head'), sidebar: styles('.bt-leftcol') } }
  })
  const filename = path.join(out, `${label}.png`)
  await page.screenshot({ path: filename, animations: 'disabled' })
  receipt.screenshots.push({ label, path: filename, sha256: createHash('sha256').update(readFileSync(filename)).digest('hex'), state })
  await context.close()
  console.log(`截图已保存：${filename}`)
}

try {
  await capture('original', 'http://127.0.0.1:5206/', false)
  if (candidateUrl) {
    await capture('candidate', candidateUrl, true)
    execFileSync('python3', ['-c', `from PIL import Image,ImageDraw,ImageFont\nfrom pathlib import Path\np=Path(${JSON.stringify(out)})\na=Image.open(p/'original.png').convert('RGB'); b=Image.open(p/'candidate.png').convert('RGB')\nc=Image.new('RGB',(a.width+b.width,max(a.height,b.height)+44),'#e9edf2'); c.paste(a,(0,44)); c.paste(b,(a.width,44))\nd=ImageDraw.Draw(c); font=ImageFont.truetype('/System/Library/Fonts/Supplemental/Arial Unicode.ttf',19)\nd.text((16,10),'DS-Bot 原版窗口 / 固定视觉夹具',font=font,fill='#1c2638'); d.text((a.width+16,10),'g-group 候选窗口 / 同一视觉夹具',font=font,fill='#1c2638')\nc.save(p/'side-by-side.png')`])
    console.log(`并排图已保存：${path.join(out, 'side-by-side.png')}`)
  }
} finally {
  writeFileSync(path.join(out, 'receipt.json'), JSON.stringify(receipt, null, 2))
  await browser.close()
  await server.close()
}
