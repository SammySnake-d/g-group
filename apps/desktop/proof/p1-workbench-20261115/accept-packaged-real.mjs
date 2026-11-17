// 真实安装包验收。凭据只从本机设置 owner 读入内存；临时配置退出后删除，证明不含凭据。
// 用法: node <本脚本> <打包二进制绝对路径> <新证据目录绝对路径>
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron, expect } from '@playwright/test'

const [bin, out] = process.argv.slice(2)
assert(bin && out && path.isAbsolute(bin) && path.isAbsolute(out))
assert(!existsSync(out), '每次用新证据目录')
mkdirSync(out, { recursive: true })
const model = 'fengshao1227/deepseek-v4.1-flash'
const owner = JSON.parse(readFileSync(path.join(os.homedir(), '.claude/settings.json'), 'utf8')).env
assert(owner.ANTHROPIC_BASE_URL && owner.ANTHROPIC_AUTH_TOKEN, '本机凭据 owner 缺配置')
const log = (text) => { console.log(text); appendFileSync(path.join(out, 'steps.log'), `${new Date().toISOString()} ${text}\n`) }
const dir = mkdtempSync(path.join(os.tmpdir(), 'gg-feishao-accept-'))
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'ELECTRON_RUN_AS_NODE' && !k.startsWith('GG_') && !k.startsWith('ANTHROPIC_')))
const result = { model, packaged: null, checks: [], errors: [], startedAt: new Date().toISOString(), binarySha256: createHash('sha256').update(readFileSync(bin)).digest('hex') }
let app
try {
  app = await electron.launch({ executablePath: bin, env: { ...env, GG_USER_DATA_DIR: dir, GG_UPDATE_AUTO: 'off' } })
  const win = await app.firstWindow()
  win.setDefaultTimeout(30000)
  win.on('pageerror', (e) => result.errors.push(e.message))
  result.packaged = await app.evaluate(({ app }) => ({ packaged: app.isPackaged, version: app.getVersion() }))
  assert(result.packaged.packaged)
  await expect(win.getByTestId('setup-model')).toHaveValue('')
  await win.getByTestId('setup-base-url').fill(owner.ANTHROPIC_BASE_URL)
  await win.getByTestId('setup-token').fill(owner.ANTHROPIC_AUTH_TOKEN)
  await win.getByTestId('setup-models-load').click()
  await expect(win.getByTestId('setup-model-options')).toContainText(model)
  await win.getByTestId('setup-model-options').selectOption(model)
  await Promise.all([win.waitForEvent('load'), win.getByTestId('setup-save').click()])
  await expect(win.getByTestId('backend-demo')).toHaveAttribute('data-mode', 'connected')
  result.checks.push('首次目录读取并明确选择 feishao 模型')
  log('PACKAGED_FEISHAO_ONBOARDING_OK')

  const add = async (name) => {
    await win.getByTestId('nav-contacts').click()
    await win.getByTestId('list').getByText('添加联系人', { exact: true }).click()
    await win.getByPlaceholder('比如：设计师').fill(name)
    await win.getByRole('button', { name: '添加', exact: true }).click()
    await expect(win.getByTestId('chat').locator('header')).toContainText(name)
  }
  await add('飞勺验收甲')
  await win.getByTestId('composer').fill('这是桌面私聊验收。请调用 reply 工具在本会话只回复 FEISHAO_DM_OK，不要派活，不要解释。')
  await win.getByTestId('composer').press('Enter')
  const replies = () => win.getByTestId('chat-column').locator('[data-msg][data-from]:not([data-from="me"])').filter({ hasNot: win.locator('[data-testid^="failure-details-"]') })
  await expect(replies().filter({ hasText: 'FEISHAO_DM_OK' })).toHaveCount(1, { timeout: 240000 })
  await win.screenshot({ path: path.join(out, '01-真实私聊.png') })
  result.checks.push('真实私聊回复 FEISHAO_DM_OK')
  log('PACKAGED_FEISHAO_DM_OK')

  await win.getByTestId('nav-contacts').click()
  await win.getByTestId('list').locator('[data-testid^="contact-"]').filter({ hasText: '飞勺验收甲' }).click()
  await win.getByTestId('wb-tab-duty').click()
  await win.getByTestId('duty-default-edit').click()
  await win.getByTestId('duty-default-edit-input').fill('验收负责人')
  await win.getByTestId('duty-default-edit-save').click()
  await expect(win.getByTestId('duty-default-edit')).toHaveText('验收负责人')
  await win.getByTestId('preset-edit').fill('回复简短，优先使用 reply 工具答复用户。')
  await win.getByTestId('preset-save').click()
  await expect(win.getByTestId('preset-state')).toHaveText('已保存')
  await win.getByTestId('wb-tab-process').click()
  await expect(win.getByTestId('run-row').first()).toBeVisible()
  await win.screenshot({ path: path.join(out, '02-真实联系人台账.png') })
  result.checks.push('工作台职责、预设保存及真实模型运行台账')

  await add('飞勺验收乙')
  await win.getByTestId('nav-contacts').click()
  await win.getByTestId('list').getByText('发起群聊', { exact: true }).click()
  await win.getByLabel('群名').fill('飞勺真实验收群')
  for (const n of ['飞勺验收甲', '飞勺验收乙']) await win.locator('label').filter({ hasText: n }).getByRole('checkbox').click()
  await win.getByRole('button', { name: '创建群聊（3 人）' }).click()
  await expect(win.getByTestId('chat-title')).toContainText('飞勺真实验收群')
  await win.getByTestId('composer').fill('请调用 reply 工具在本群只回复 FEISHAO_GROUP_OK，不要派活。 @飞勺验收甲')
  await win.getByTestId('composer').press('Enter')
  await win.getByTestId('composer').press('Enter')
  await expect(replies().filter({ hasText: 'FEISHAO_GROUP_OK' })).toHaveCount(1, { timeout: 240000 })
  await win.screenshot({ path: path.join(out, '03-真实群聊.png') })
  result.checks.push('建群及 @ 指定 agent 真实回复 FEISHAO_GROUP_OK')
  log('PACKAGED_FEISHAO_GROUP_OK')

  await win.getByTestId('head-side').click()
  await win.getByTestId('side-tab-notice').click()
  await win.getByTestId('notice-add').click()
  await win.getByTestId('notice-input').fill('真实后端公告：先给结论。')
  await win.getByTestId('notice-save').click()
  await expect(win.getByTestId('strip-text')).toContainText('真实后端公告')
  const msg = win.getByTestId('chat-column').locator('[data-from="me"]').first()
  await msg.click({ button: 'right' })
  await win.getByTestId('ctx-pin').click()
  await win.getByTestId('strip-next').click()
  await expect(win.getByTestId('strip-text')).toContainText('FEISHAO_GROUP_OK')
  await win.screenshot({ path: path.join(out, '04-公告置顶.png') })
  result.checks.push('真实后端公告与置顶')
  assert.deepEqual(result.errors, [])
  result.ok = true
} catch (e) {
  result.ok = false
  result.failure = e.message
  const win = app?.windows()[0]
  if (win && !(await win.getByTestId('setup-screen').count())) await win.screenshot({ path: path.join(out, '失败现场.png') }).catch(() => {})
  process.exitCode = 1
} finally {
  await app?.close().catch(() => {})
  rmSync(path.join(dir, 'gg-config.json'), { force: true })
  // 不交付任何用户目录、网关地址、令牌，只保留界面和结果。
  rmSync(dir, { recursive: true, force: true })
  result.finishedAt = new Date().toISOString()
  writeFileSync(path.join(out, 'result.json'), JSON.stringify(result, null, 2))
  log(result.ok ? 'PACKAGED_REAL_ACCEPT_OK' : `PACKAGED_REAL_ACCEPT_FAILED: ${result.failure}`)
}
