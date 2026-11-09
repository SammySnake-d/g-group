import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { chromium } from '@playwright/test'

const out = process.env.GG_SHOTS
if (!out) throw new Error('GG_SHOTS is required')
fs.mkdirSync(path.join(out, 'design-preview'), { recursive: true })
const url = pathToFileURL(path.resolve('design-dist/index.html')).href
const browser = await chromium.launch({ channel: 'chrome', args: ['--disable-features=MacAppCodeSignClone'] })
const result = { source: url, cases: [], errors: [], motion: null }
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN', deviceScaleFactor: 1 })
  page.on('pageerror', (e) => result.errors.push(String(e)))
  page.on('console', (m) => { if (m.type() === 'error') result.errors.push(m.text()) })
  await page.goto(url)
  await page.locator('[data-testid=shelf-a1]').waitFor()
  assert.equal(await page.locator('[data-testid^=shelf-]').count(), 5)
  await page.screenshot({ path: path.join(out, 'design-preview', '文件-浅色.png') })
  await page.getByTestId('shelf-a1').hover()
  await page.getByRole('button', { name: '快速查看IM 竞品交互对照', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await dialog.waitFor()
  result.motion = await dialog.evaluate((el) => ({ animationDuration: getComputedStyle(el).animationDuration, animationName: getComputedStyle(el).animationName }))
  await page.keyboard.press('Escape')
  await page.getByTestId('shelf-a1').getByRole('heading', { level: 2 }).click()
  await page.getByTestId('file-discuss').click()
  await page.getByTestId('composer').waitFor()
  assert.match(await page.getByTestId('composer').inputValue(), /@Astra/)
  assert.match(await page.getByTestId('quote-text').innerText(), /IM 竞品交互对照/)
  result.cases.push('离线 HTML：打开、快速查看、引用并回对话')
  await page.goto(url + '?theme=dark')
  await page.getByTestId('shelf-a1').waitFor()
  await page.screenshot({ path: path.join(out, 'design-preview', '文件-深色.png') })
  for (const mode of ['worst', 'empty', 'one', 'many']) {
    await page.setViewportSize({ width: 1024, height: 768 })
    await page.goto(url + '?files-fixture=' + mode)
    await page.getByTestId('files-main').waitFor()
    const count = await page.locator('[data-testid^=shelf-]').count()
    assert.equal(count, { worst: 5, empty: 0, one: 1, many: 24 }[mode])
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)
    assert.ok(overflow <= 0, `${mode} overflow ${overflow}`)
    if (mode === 'one') {
      const box = await page.getByTestId('shelf-a1').boundingBox()
      assert.ok(box.width < 500, `单个文件不铺满整页：${box.width}`)
    }
    if (mode === 'many') {
      await page.getByRole('button', { name: '显示更多' }).click()
      assert.equal(await page.locator('[data-testid^=shelf-]').count(), 48)
    }
    if (mode === 'worst') {
      await page.getByTestId('shelf-a1').getByRole('heading', { level: 2 }).click()
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    }
    await page.screenshot({ path: path.join(out, 'design-preview', `${mode}.png`) })
    result.cases.push(`1024px ${mode}：对象数量、溢出、操作`) 
  }
  await page.setViewportSize({ width: 1920, height: 1080 })
  await page.goto(url)
  await page.getByTestId('shelf-a1').waitFor()
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
  result.cases.push('1920px：无横向溢出')
  assert.deepEqual(result.errors, [])
  console.log(JSON.stringify(result, null, 2))
} finally {
  await browser.close()
  fs.writeFileSync(path.join(out, 'design-preview', 'verification.json'), JSON.stringify(result, null, 2))
}
