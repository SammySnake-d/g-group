import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const repo = path.resolve(import.meta.dirname, '../../..')
const upstream = path.join(repo, 'apps/desktop/src/dsbot-base/upstream')
const manifest = JSON.parse(readFileSync(path.join(repo, 'third_party/ds-bot/SOURCE-MANIFEST.json'), 'utf8'))
assert.equal(manifest.commit, 'a66cc737cfb6c3d8a2597e748cded6cab1206dd3')
for (const entry of manifest.sourceFiles) {
  const actual = createHash('sha256').update(readFileSync(path.join(upstream, entry.path))).digest('hex')
  assert.equal(actual, entry.sha256, `${entry.path} 被修改`)
}
const entry = readFileSync(path.join(repo, 'apps/desktop/src/main.tsx'), 'utf8')
assert.ok(entry.includes("import './dsbot-base/upstream/app/ui/src/main.js'"))
for (const retired of ['DsBotApp', 'index.css', 'AstryxRoot', 'AnimateUIProvider']) assert.ok(!entry.includes(retired), `旧入口仍加载 ${retired}`)
const main = readFileSync(path.join(upstream, 'app/ui/src/main.js'), 'utf8')
assert.equal((main.match(/\['(?:shell|sidebar|conversation|secrets|providers|models|usage|schedules|feedback|about|members)'/g) ?? []).length, 11)
console.log(`原版完整性通过：${manifest.sourceFiles.length} 个文件原始字节一致；完整窗口入口与 11 组样式已接入。此检查不代替视觉/打包版实点验收。`)
