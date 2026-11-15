#!/usr/bin/env node
// 在独立的 detached 工作树上执行定点破坏；不要把作者工作树作为第一个参数。
// node scripts/pr101-mutants.mjs <独立工作树根> <输出目录>
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
const [target, output] = process.argv.slice(2).map((p) => path.resolve(p))
const own = path.resolve(import.meta.dirname, '../../..')
if (target === own) throw new Error('只允许修改独立的变异副本')
const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: target, encoding: 'utf8' }).trim()
if (branch !== 'HEAD') throw new Error('变异副本必须是 detached HEAD')
mkdirSync(output, { recursive: true })
const desktop = path.join(target, 'apps/desktop')
const cases = [
  { id: 'M-PASTE', file: 'src/components/Composer.tsx', before: 'if (!editing) void addDraftImages(conv.id, images)', after: "if (!editing) void attachLive(liveCtx(useAppStore.getState, useAppStore.setState), conv.id, images)", test: '图片粘贴先进待发区' },
  { id: 'M-REMOVE', file: 'src/app/composer/imageDrafts.ts', before: 'd.images.filter((x) => !ids.includes(x.id))', after: '[]', test: '图片粘贴先进待发区' },
  { id: 'M-DRAFT', file: 'src/app/composer/imageDrafts.ts', before: 'const images = rows.map((x) => ({ ...x, file: new File([x.file], x.name, { type: x.file.type }) }))', after: 'const images: DraftImage[] = []', test: '图片草稿按会话保存' },
  { id: 'M-PREVIEW', file: 'src/components/messages/cards/MsgFiles.tsx', before: 'e.stopPropagation(); setOpen(true)', after: 'e.stopPropagation(); setOpen(false)', test: '多图和文字只发一条消息' },
]
const results = []
for (const c of cases) {
  const filename = path.join(desktop, c.file)
  const original = readFileSync(filename, 'utf8')
  if (original.split(c.before).length !== 2) throw new Error(`${c.id} 的替换点不是一个`)
  const log = path.join(output, `${c.id}.txt`)
  try {
    writeFileSync(filename, original.replace(c.before, c.after))
    const build = spawnSync('npm', ['run', 'build:renderer'], { cwd: desktop, encoding: 'utf8', timeout: 120_000 })
    writeFileSync(log, build.stdout + build.stderr)
    if (build.status !== 0) throw new Error(`${c.id} 构建失败，不算杀死`)
    // 外层由 serial.mjs 持有唯一全机锁；这里不嵌套取锁。
    const run = spawnSync('npx', ['playwright', 'test', '--project=electron', 'e2e/pr101-p0.electron.spec.ts', '--grep', c.test], { cwd: desktop, encoding: 'utf8', timeout: 120_000 })
    writeFileSync(log, readFileSync(log, 'utf8') + run.stdout + run.stderr)
    const text = run.stdout + run.stderr
    const killed = run.status === 1 && /1 failed/.test(text) && /Error: expect\(locator\)/.test(text) && !run.error
    results.push({ id: c.id, criterion: c.test, exit: run.status, killed, other_criteria_failures: '未运行其他判据；本轮只声明定点检出，不声称隔离性全覆盖', log: `${c.id}.txt` })
    console.log(c.id, killed ? '按行为断言检出' : '未按预期检出')
  } finally { writeFileSync(filename, original) }
}
writeFileSync(path.join(output, 'result.json'), JSON.stringify({ source: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: target, encoding: 'utf8' }).trim(), results }, null, 2) + '\n')
process.exit(results.every((r) => r.killed) ? 0 : 1)
