// 新安装包 + 指定 feishao 模型 + 本机真实 Claude Code Compute；不使用替身。
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron, expect } from '@playwright/test'
const [bin, out, contactMode = 'pi'] = process.argv.slice(2)
assert(['pi', 'fake'].includes(contactMode))
assert(bin && out && path.isAbsolute(bin) && path.isAbsolute(out) && !existsSync(out))
mkdirSync(out, { recursive: true })
const dir = mkdtempSync(path.join(os.tmpdir(), 'gg-feishao-compute-'))
const owner = JSON.parse(readFileSync(path.join(os.homedir(), '.claude/settings.json'), 'utf8')).env
const model = 'fengshao1227/deepseek-v4.1-flash'
assert(owner.ANTHROPIC_BASE_URL && owner.ANTHROPIC_AUTH_TOKEN)
writeFileSync(path.join(dir, 'gg-config.json'), JSON.stringify({ gateway: { baseUrl: owner.ANTHROPIC_BASE_URL, token: owner.ANTHROPIC_AUTH_TOKEN, model } }), { mode: 0o600 })
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'ELECTRON_RUN_AS_NODE' && !k.startsWith('GG_') && !k.startsWith('ANTHROPIC_')))
const result = { model, contactMode, realCompute: true, checks: [], startedAt: new Date().toISOString() }
let app
try {
  app = await electron.launch({ executablePath: bin, env: { ...env, GG_USER_DATA_DIR: dir, GG_MIND: contactMode, GG_COMPUTE: 'claude', GG_UPDATE_AUTO: 'off' } })
  const win = await app.firstWindow()
  win.setDefaultTimeout(30000)
  result.app = await app.evaluate(({ app }) => ({ packaged: app.isPackaged, version: app.getVersion() }))
  await expect(win.getByTestId('backend-demo')).toHaveAttribute('data-mode', 'connected')
  result.backend = await win.evaluate(() => window.ggApp.invoke('setup.get', {}))
  await win.getByTestId('nav-contacts').click()
  await win.getByTestId('list').getByText('添加联系人', { exact: true }).click()
  await win.getByPlaceholder('比如：设计师').fill('飞勺 Compute 验收')
  await win.getByRole('button', { name: '添加', exact: true }).click()
  await expect(win.getByTestId('chat').locator('header')).toContainText('飞勺 Compute 验收')
  await win.getByTestId('composer').fill(contactMode === 'fake' ? '帮我整理 飞勺文件验收：在自己的工作目录写 feishao-compute.txt，内容精确为 FEISHAO_COMPUTE_OK；先用 report_progress 报 started，完成后报 completed。只在本任务工作目录操作，不调用其他模型，不启动或停止其他进程。' : '请现在调用 dispatch_compute 工具派一个 Compute，标题「飞勺文件验收」。任务：在自己的工作目录写 feishao-compute.txt，内容精确为 FEISHAO_COMPUTE_OK；先用 report_progress 报 started，完成后报 completed，并交付该文件。只在本任务工作目录操作，不调用其他模型，不启动或停止其他进程。不要只回复口头答应。')
  await win.getByTestId('composer').press('Enter')
  const line = win.getByTestId('chat-column').locator('[data-testid^="compute-line-"]').first()
  await expect(line).toBeVisible({ timeout: 240000 })
  result.checks.push(contactMode === 'fake' ? '规则联系人派出真实 Compute' : '真实联系人派出 Compute')
  console.log('REAL_FEISHAO_DISPATCH_OK')
  const taskId = (await line.getAttribute('data-testid')).slice('compute-line-'.length)
  result.taskId = taskId
  await expect.poll(async () => win.evaluate((taskId) => window.gg.invoke('tasks.progress', { taskId }).then((r) => r.ok && r.value.progress.some((x) => x.kind === 'completed')), taskId), { timeout: 360000, intervals: [1000, 3000, 5000] }).toBe(true)
  const task = await win.evaluate((taskId) => window.gg.invoke('tasks.get', { taskId }), taskId)
  assert(task.ok)
  result.taskState = task.value.state
  result.modelAttempts = task.value.modelAttempts
  result.modelSnapshot = task.value.modelSnapshot
  assert(result.modelAttempts.length && result.modelAttempts.every((attempt) => attempt.model === model), '实际尝试账本必须只使用指定 feishao 模型')
  const run = task.value.computeRuns.find((x) => x.status === 'completed')
  assert(run && run.model === model, '真实 Compute run 必须完成且使用指定模型')
  const file = path.join(dir, 'gg-data', 'compute', taskId, 'feishao-compute.txt')
  assert.equal(readFileSync(file, 'utf8').trim(), 'FEISHAO_COMPUTE_OK')
  result.checks.push('真实 Compute 上游完成、进度 completed、交付内容吻合、实际尝试模型匹配')
  await line.click()
  await win.getByTestId('cview-activity').click()
  result.computeLineState = await line.getAttribute('data-state')
  result.activity = await win.getByTestId('activity').innerText()
  await win.screenshot({ path: path.join(out, '真实Compute完成.png') })
  result.acceptanceComplete = ['T8a_Delivered', 'T8_Accepted'].includes(task.value.state)
  if (!result.acceptanceComplete) result.remainingGap = `Compute run 已完成，但任务仍处于 ${task.value.state}; 桌面状态 ${result.computeLineState}`
  result.checks.push('打包版查看 Compute 过程页')
  result.ok = true
} catch (e) {
  result.ok = false
  result.failure = e.message
  const win = app?.windows()[0]
  if (win) {
    await win.screenshot({ path: path.join(out, '失败现场.png') }).catch(() => {})
    result.visible = await win.getByTestId('chat-column').innerText().catch(() => '')
    if (result.taskId) {
      result.runs = await win.evaluate((taskId) => window.gg.invoke('runs.list', {}).then((r) => r.ok ? r.value.runs.filter((x) => x.taskId === taskId) : r), result.taskId).catch(() => null)
      result.progress = await win.evaluate((taskId) => window.gg.invoke('tasks.progress', { taskId }), result.taskId).catch(() => null)
      const line = win.getByTestId(`compute-line-${result.taskId}`)
      await line.click().catch(() => {})
      await win.getByTestId('cview-activity').click().catch(() => {})
      await win.screenshot({ path: path.join(out, '运行证据.png') }).catch(() => {})
    }
  }
  process.exitCode = 1
} finally {
  await app?.close().catch(() => {})
  rmSync(path.join(dir, 'gg-config.json'), { force: true })
  if (result.ok) rmSync(dir, { recursive: true, force: true })
  else result.retainedEvidenceDir = dir
  // setup.get 的地址不是验收输出；只留运行模式，不留网关或本机 CLI 路径。
  if (result.backend?.ok) result.backend = result.backend.value.backend
  result.finishedAt = new Date().toISOString()
  writeFileSync(path.join(out, 'result.json'), JSON.stringify(result, null, 2))
  console.log(result.ok ? result.acceptanceComplete ? 'REAL_FEISHAO_COMPUTE_ACCEPTED' : 'REAL_FEISHAO_COMPUTE_PARTIAL' : `REAL_FEISHAO_COMPUTE_FAILED: ${result.failure}`)
}
