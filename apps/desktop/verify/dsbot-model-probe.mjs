// One bounded request to the user's selected fengshao route. No credentials are
// printed or written; the existing machine configuration remains their owner.
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const owner = process.env.GG_CREDENTIAL_OWNER || path.join(os.homedir(), '.claude/settings.json')
const output = process.argv[2] || '/tmp/dsbot-astra-20261117/model-probe.json'
const stored = JSON.parse(readFileSync(owner, 'utf8'))
const gateway = stored.gateway || {
  baseUrl: stored.env?.ANTHROPIC_BASE_URL,
  token: stored.env?.ANTHROPIC_AUTH_TOKEN,
}
if (!gateway.baseUrl || !gateway.token) throw new Error('配置 owner 中缺少网关地址或令牌')
const origin = gateway.baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '')
const receipt = { owner, startedAt: new Date().toISOString(), model: null, catalogVerified: false, status: null, text: '', keepalives: 0, outcome: 'not-started' }
const headers = { authorization: `Bearer ${gateway.token}`, 'x-api-key': gateway.token, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }
try {
  const catalog = await fetch(`${origin}/v1/models`, { headers, signal: AbortSignal.timeout(15_000) })
  if (!catalog.ok) throw new Error(`模型目录 HTTP ${catalog.status}`)
  const body = await catalog.json()
  const rows = Array.isArray(body.data) ? body.data : body.models ?? []
  const model = rows.find(row => row.id === 'fengshao1227/deepseek-v4.1-flash')?.id
  if (!model) throw new Error('本机网关目录没有 fengshao1227/deepseek-v4.1-flash，未发生成请求')
  receipt.model = model
  receipt.catalogVerified = true
  receipt.outcome = 'request-started'
  const response = await fetch(`${origin}/v1/messages`, {
    method: 'POST', headers, signal: AbortSignal.timeout(40_000),
    body: JSON.stringify({ model, max_tokens: 64, stream: true, messages: [{ role: 'user', content: '请只回复：已收到' }] }),
  })
  receipt.status = response.status
  if (!response.ok) {
    receipt.outcome = 'http-error'
    receipt.error = (await response.text()).slice(0, 600)
  } else {
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let end
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end).trim()
        buffer = buffer.slice(end + 1)
        if (/keepalive|^:\s*ping|event:\s*ping/.test(line)) receipt.keepalives++
        if (line.startsWith('data:')) {
          try {
            const event = JSON.parse(line.slice(5))
            if (event.type === 'ping') receipt.keepalives++
            if (event.delta?.type === 'text_delta') receipt.text += event.delta.text || ''
            if (event.type === 'content_block_start' && event.content_block?.type === 'text') receipt.text += event.content_block.text || ''
          } catch { /* SSE comments and end markers are not content. */ }
        }
      }
    }
    receipt.outcome = receipt.text ? 'content-received' : 'no-content'
  }
} catch (error) {
  receipt.outcome = receipt.text ? 'content-received-stream-interrupted' : receipt.status === 200 ? 'no-content-timeout' : 'blocked'
  receipt.error = error instanceof Error ? error.message : String(error)
} finally {
  receipt.finishedAt = new Date().toISOString()
  mkdirSync(path.dirname(output), { recursive: true })
  writeFileSync(output, JSON.stringify(receipt, null, 2) + '\n')
  console.log(JSON.stringify(receipt))
}
if (receipt.outcome !== 'content-received') process.exitCode = 1
