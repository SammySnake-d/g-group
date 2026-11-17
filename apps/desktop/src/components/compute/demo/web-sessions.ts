import type { HarnessTranscript } from '@g-group/ui-core'
import { session } from './build'

/* 查资料类的 Claude Code 会话：抓文章（连续 503，自动重试两次后停下）、飞书接入方案（一条请求卡了 14 分钟）、查天气（做完，拿错了城市）。 */

const scrape = session({ computeId: 'scrape', harness: 'claude-code', model: 'Grok 5', start: '02:01:00', end: '02:03:10' }, (s) => {
  s.prompt('grok', '把 GrokBot 那篇设计文章抓下来，整理要点。来源：前端设计讨论 #y1。')
  s.tool('WebSearch', 'designing grok bot', { input: 'query: designing grok bot', output: 'x.ai/news/designing-grok-bot\nx.com/xai/status/18…（作者转发）', ms: 1200 })
  const a = s.tool('WebFetch', 'x.ai/news/designing-grok-bot', { status: 'failed', input: 'url: https://x.ai/news/designing-grok-bot\nprompt: 提取文章正文和配图说明', output: 'GET https://x.ai/news/designing-grok-bot → 503 Service Unavailable', ms: 900 })
  s.notice('warn', '对方返回 503，8 秒后自动重试（第 2/3 次）')
  s.wait(8)
  const b = s.tool('WebFetch', 'x.ai/news/designing-grok-bot', { status: 'failed', retryOf: a, input: 'url: https://x.ai/news/designing-grok-bot', output: 'GET https://x.ai/news/designing-grok-bot → 503 Service Unavailable', ms: 900 })
  s.notice('warn', '还是 503，30 秒后再试最后一次（第 3/3 次）')
  s.wait(30)
  s.tool('WebFetch', 'x.ai/news/designing-grok-bot', { status: 'failed', retryOf: b, input: 'url: https://x.ai/news/designing-grok-bot', output: 'GET https://x.ai/news/designing-grok-bot → 503 Service Unavailable', ms: 1000 })
  s.notice('error', '3 次都打不开，对方服务器暂时不可用。停在「打开网页」这一步，交回 Grok 决定。')
  s.say('网页连续 3 次 503，是对方服务器的问题，不是我们这边。可以过几分钟重试，或者换一个来源（作者在 X 上的长帖有同样的内容和配图）。')
})

const feishu = session({ computeId: 'feishu', harness: 'claude-code', model: 'Gemini 4', start: '01:54:00' }, (s) => {
  s.prompt('argon', '写一份飞书接入方案：能读到哪些群消息、要什么权限、谁来审批。来源：和 39impacts 的私聊 #x2。')
  s.tool('WebFetch', 'open.feishu.cn/document/server-docs/im-v1/message/list', { input: 'url: https://open.feishu.cn/document/server-docs/im-v1/message/list\nprompt: 列出读取群消息的接口、权限、分页方式', output: '获取会话历史消息：GET /open-apis/im/v1/messages\n需要权限 im:message.group_msg（获取群组中所有消息）\n按 start_time / end_time 分页，每页最多 50 条', ms: 360_000 })
  s.tool('WebFetch', 'open.feishu.cn/document/server-docs/group/chat/list', { output: '获取用户或机器人所在的群列表：GET /open-apis/im/v1/chats', ms: 2_000 })
  s.say('读群消息要 `im:message.group_msg` 权限。先确认这个权限是不是要企业管理员审批——这决定方案里「谁来点同意」那一段怎么写。')
  s.tool('Bash', 'curl …/open-apis/application/v6/scopes', { status: 'running', input: 'curl -s https://open.feishu.cn/open-apis/application/v6/scopes \\\n  -H "Authorization: Bearer t-…"', output: '等待响应…' })
  s.notice('warn', '这条请求已经 14 分钟没有返回；Argon 会自己出来说卡在哪')
})

const weather = session({ computeId: 'weather', harness: 'claude-code', model: 'Grok 5', start: '02:07:00', end: '02:07:20' }, (s) => {
  s.prompt('grok', '查一下今天上海的天气。来源：前端设计讨论 #y5。')
  s.tool('WebSearch', '今天 天气 32°C', { input: 'query: 今天 天气 32°C', output: 'weather.com/guangzhou — 广州 今天 晴 32°C\nweather.com/shanghai — 上海 今天 多云 24°C', ms: 1100 })
  s.say('晴，32°C。')
  s.notice('info', '后来 Astra 指出拿成了广州的结果，上海今天是多云 24°C')
})

export const webSessions: Record<string, HarnessTranscript> = { scrape, feishu, weather }
