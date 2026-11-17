// Offline replay of the reported SSE shape, through the CURRENT pi dependency
// and real Host/SQLite. Never calls a model or changes production backend code.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { createPiContactMind } from '../../../packages/adapter-pi-contact/src/mind.ts'
import { Host } from '../../../packages/server/src/host.ts'
import { scriptedCompute } from '../../../packages/server/src/fakes.ts'

const out = path.resolve(process.argv[2] || '/tmp/dsbot-astra-20261117/sse-error-control')
mkdirSync(out, { recursive: true })
const model = 'fengshao1227/deepseek-v4.1-flash'
const reportedError = { type: 'error', error: { type: 'model_unavailable', message: '当前模型不可用，请切换模型', code: 11102, msg: 'model [hy4-flash-free] service info not found' } }
const seen = []
const events = []
const encoder = new TextEncoder()
const controlFetch = async (input, init) => {
  const request = new Request(input, init)
  assert.equal(new URL(request.url).host, 'sse-control.invalid')
  const body = JSON.parse(await request.text())
  assert.equal(body.model, model)
  seen.push({ url: request.url, model: body.model, at: performance.now() })
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('event: keepalive\ndata: {}\n\n'))
      controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify(reportedError)}\n\n`))
      controller.close()
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
}
const mind = createPiContactMind({ provider: 'offline-control', model, baseUrl: 'http://sse-control.invalid', apiKey: ['offline', 'fixture', 'not-a-credential'].join('-'), fetch: controlFetch })
const compute = scriptedCompute()
const host = new Host({ file: path.join(mkdtempSync(path.join(tmpdir(), 'dsbot-sse-control-')), 'control.db'), mind: () => mind, compute: () => compute.adapter, maxDeferMs: 5 })
const began = performance.now()
const stop = host.bus.subscribe(event => {
  if (['run.updated', 'retry.updated', 'contact.activity', 'message.appended'].includes(event.type)) events.push({ elapsedMs: Math.round(performance.now() - began), ...event })
})
const receipt = { mode: 'offline SSE error -> current pi-ai -> real Host/SQLite', realModelAcceptance: false, model, startedAt: new Date().toISOString(), reportedError, errors: [] }
try {
  const contact = host.createContact({ name: '离线错误回放', speakingModel: model })
  const dm = host.openDm(contact.id)
  host.send({ roomId: dm.id, clientActionId: 'offline-sse-error', text: '离线错误回放，不调用真实模型' })
  const deadline = began + 8_000
  while (performance.now() < deadline) {
    const runs = host.listRuns({ contactId: contact.id }).runs
    const card = host.listMessages(dm.id, {}).messages.find(message => message.card?.kind === 'failure')
    if (runs.length && runs.every(run => run.status !== 'running') && card) {
      receipt.elapsedMs = Math.round(performance.now() - began)
      receipt.runs = runs
      receipt.failureMessage = card
      receipt.contact = host.listContacts().find(item => item.id === contact.id)
      break
    }
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.ok(receipt.failureMessage, '8 秒内没有落失败卡')
  assert.ok(receipt.runs.some(run => run.status === 'failed'))
  assert.ok(!receipt.runs.some(run => run.status === 'running'))
  assert.equal(receipt.contact.activity, 'idle')
  assert.match(receipt.failureMessage.card.body, /11102/)
  assert.equal(compute.spawned.length, 0)
  receipt.outcome = 'failed-round-card-and-idle-observed'
} catch (error) {
  receipt.outcome = 'failed-control'
  receipt.errors.push(error.stack)
  process.exitCode = 1
} finally {
  stop(); compute.close(); await host.close()
  receipt.requests = seen.map(({ at, ...request }) => ({ ...request, elapsedMs: Math.round(at - began) }))
  receipt.events = events
  receipt.finishedAt = new Date().toISOString()
  writeFileSync(path.join(out, 'receipt.json'), JSON.stringify(receipt, null, 2))
  console.log(JSON.stringify({ outcome: receipt.outcome, elapsedMs: receipt.elapsedMs, requests: seen.length, errors: receipt.errors }, null, 2))
}
