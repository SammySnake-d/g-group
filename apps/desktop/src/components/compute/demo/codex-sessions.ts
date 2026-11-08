import type { HarnessTranscript } from '@g-group/ui-core'
import { ch, session } from './build'

/* Codex 会话：首页性能（做完，先量再改再量）、查报错日志（在跑，卡在登录）、IM 竞品对照（做完，4 路子代理，其中一路失败后重派）。
   Codex 的工具名照它自己的：shell、apply_patch、update_plan、web_search、browser。 */

const perf = session({ computeId: 'perf', harness: 'codex', model: 'GPT-6.1', start: '01:30:00', end: '01:48:00', background: [{ id: 'dev', command: 'pnpm dev --port 5173', state: 'killed' }] }, (s) => {
  s.prompt('codex', '首页打开太慢了，查一下。来源：模型助手群聊 #g4。')
  s.tool('update_plan', '量首屏 → 找原因 → 改 → 再量 → 交 Astra 复核', { ms: 100 })
  s.say('先量一下首屏时间，看慢在哪。')
  s.tool('shell', 'npx lighthouse http://localhost:5173 --only-audits=first-contentful-paint', { input: 'npx lighthouse http://localhost:5173 --only-audits=first-contentful-paint --quiet --output=json | jq .audits', output: 'first-contentful-paint: 3.1 s', ms: 6_000 })
  s.tool('shell', 'curl …/api/history?room=g | jq length', { input: 'curl -s "localhost:5173/api/history?room=g" | jq length', output: '2814', ms: 900 })
  s.tool('shell', 'curl -w %{size_download} …/api/history?room=g', { input: 'curl -s -o /dev/null -w "%{size_download}" "localhost:5173/api/history?room=g"', output: '1938211', ms: 800 })
  s.say('慢在首屏一次拉了全部历史消息：2,814 条，1.9 MB。改成先拉最近 50 条，往上翻再分页加载。')
  s.tool('shell', 'rg -n "api.history" src/store', { output: 'src/store/messages.ts:31:  const all = await api.history(roomId)', ms: 200 })
  s.tool('apply_patch', 'store/messages.ts', { input: '*** Update File: src/store/messages.ts\n@@ 拉取消息 @@\n-  const all = await api.history(roomId)\n+  const recent = await api.history(roomId, { last: 50 })\n+  onScrollTop(() => loadOlder(roomId))', changes: [ch('src/store/messages.ts', 2, 1)], ms: 900 })
  s.tool('shell', 'pnpm test history', { output: 'PASS 往上翻能接着加载（翻 3 页共 150 条，无重复、无缺口）\n1 passed (1.4s)', ms: 4_000 })
  s.tool('shell', 'npx lighthouse … 再量一次', { input: 'npx lighthouse http://localhost:5173 --only-audits=first-contentful-paint --quiet', output: 'first-contentful-paint: 0.9 s', ms: 6_000 })
  s.wait(300).say('首屏从 3.1 秒降到 0.9 秒。已交 Astra 换 GPT-6 复核：往上翻能接着加载，没有重复消息。')
  s.deliver('拉取改成最近 50 条', 'diff', 'src/store/messages.ts')
  s.deliver('首屏前后对比', 'file', 'lighthouse-before-after.json', '4 KB')
})

const logs = session({ computeId: 'logs', harness: 'codex', model: 'GPT-5.5', start: '02:13:00' }, (s) => {
  s.prompt('codex', '登录运维后台，查昨晚 02:00 前后的报错日志。来源：和 39impacts 的私聊 #z1。')
  s.tool('browser', '打开 ops.team.com/login', { output: '登录页：用户名、密码、图形验证码', ms: 2_400 })
  s.say('后台登录要图形验证码。先看看有没有可以免验证码的 API Token。')
  s.tool('shell', 'rg -n "OPS_TOKEN" ~/.config', { output: '没有找到', ms: 300 })
  s.tool('browser', '填用户名 ops-bot、密码', { ms: 1_200 })
  s.tool('browser', '等验证码', { status: 'running', output: '验证码只有人能过，准备交给 39impacts' })
})

const research = session({ computeId: 'research', harness: 'codex', model: 'GPT-6', day: '2026-11-08', start: '22:40:00', end: '23:06:00' }, (s) => {
  s.prompt('astra', '整理 IM 竞品的交互：QQ、Telegram、GrokBot、iMessage 都看看，写成对照文档。来源：模型助手群聊 #g1。')
  s.say('四款分开看，各派一个子代理，只记交互、不评价；最后我来合成一张对照表。')
  s.agent('QQ 群聊交互', '看 QQ 群聊的回复、引用、@、撤回、已读，只记交互，不评价。', { status: 'done', calls: 12, ms: 400_000, result: '回复带原文引用；@ 有「全体成员」；撤回限 2 分钟；群聊没有已读回执。' })
  s.agent('Telegram 群聊交互', '看 Telegram 的回复、话题(Topics)、置顶、已读，只记交互。', { status: 'done', calls: 15, ms: 482_000, result: '回复可跳回原消息并高亮；话题把大群拆成子频道；置顶可以多条；私聊有双勾已读。' })
  s.agent('GrokBot 交互', '看 GrokBot 的多人对话、引用和中途打断，只记交互。', { status: 'failed', calls: 3, ms: 70_000, result: '官网 503，截图没拿到。', trail: (t) => {
    t.tool('web_search', 'grok bot group chat', { output: 'x.ai/news/designing-grok-bot', ms: 900 })
    const a = t.tool('browser', '打开 x.ai/news/designing-grok-bot', { status: 'failed', output: '503 Service Unavailable', ms: 900 })
    t.tool('browser', '打开 x.ai/news/designing-grok-bot', { status: 'failed', retryOf: a, output: '503 Service Unavailable', ms: 900 })
  } })
  s.agent('iMessage 交互', '看 iMessage 的回复线程、Tapback、已读和编辑，只记交互。', { status: 'done', calls: 10, ms: 295_000, result: '回复形成线程；Tapback 是轻量回应；已读可关；编辑限 15 分钟，会留「已编辑」。' })
  s.wait(480).say('GrokBot 那一路没打开官网。换成看作者在 X 上的长帖和截图，重新派一次。')
  s.agent('GrokBot 交互（重派）', '官网打不开，改看作者在 X 上的长帖与截图，只记交互。', { status: 'done', calls: 9, ms: 331_000, result: '多人同时在一个对话里；引用会带上原话片段；可以中途打断并补一句。' })
  s.wait(340).say('四款都齐了，写成对照表：同一行比较同一个交互，最后一列写我们要不要跟。')
  s.tool('apply_patch', 'docs/IM竞品交互对照.md', { input: '*** Add File: docs/IM竞品交互对照.md\n+ | 交互 | QQ | Telegram | GrokBot | iMessage | 我们 |\n+ | --- | --- | --- | --- | --- | --- |\n+ …', changes: [ch('docs/IM竞品交互对照.md', 186)], ms: 9_000 })
  s.deliver('IM 竞品交互对照', 'file', 'docs/IM竞品交互对照.md', '12 KB')
})

export const codexSessions: Record<string, HarnessTranscript> = { perf, logs, research }
