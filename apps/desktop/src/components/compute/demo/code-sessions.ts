import type { HarnessTranscript } from '@g-group/ui-core'
import { ch, session } from './build'

/* 写代码类的 Claude Code 会话：登录页深色（在跑、测试失败后重试）、快捷键、搜索跳转（在跑）、复核验收文档（做完，一次改动失败后重试）。 */

const login = session({ computeId: 'login', harness: 'claude-code', model: 'Claude Opus 5.5', start: '02:12:00', turns: 3, nativeSessionId: 'demo-login', background: [{ id: 'dev', command: 'pnpm dev --port 5173', state: 'running' }] }, (s) => {
  s.prompt('claude', '把登录页改成深色主题，顺便把测试补上。\n\n来源：模型助手群聊里 39impacts 的原话 #g8。\n主题变量在 theme/tokens.css（群协作手册 pb6）。\n验收看 AC-24：深色下对比度 ≥ 4.5、输入框聚焦有可见描边、切换主题不闪白、7 天内免登。\n改完先交 Astra 复核，再请 39impacts 验收。')
  s.say('先看登录页和现有主题是怎么写的。')
  s.tool('Read', 'pages/Login.tsx', { input: 'pages/Login.tsx', output: '120 行。颜色直接写在组件里：bg-white、border-gray-200、text-gray-900\n表单在 14–20 行，没有「记住登录」', ms: 400 })
  s.tool('Read', 'theme/tokens.css', { input: 'theme/tokens.css', output: '只有浅色一套变量(--surface / --fg / --line)，没有 .dark', ms: 200 })
  s.tool('Grep', '"bg-white" in src', { input: 'pattern: bg-white\npath: src\noutput_mode: content', output: '7 处匹配\npages/Login.tsx:15\npages/Register.tsx:12\ncomponents/Card.tsx:8\n… 另外 4 处不在登录流程里', ms: 300 })
  s.agent('扫一遍别的页面有没有写死的浅色', '在 src/ 下找写死的浅色(bg-white、text-gray-*、border-gray-*)，列出文件和行号。只读，不改。', {
    status: 'done', calls: 9, ms: 48_000,
    result: '登录流程以外还有 4 处：\n- Register.tsx 12 行\n- Card.tsx 8 行\n- Settings.tsx 31 行\n- Toast.tsx 5 行\n\n这次不动，写进交付说明。',
    trail: (t) => {
      t.tool('Grep', '"text-gray-" in src', { output: '11 处匹配', ms: 300 })
      t.tool('Grep', '"border-gray-" in src', { output: '6 处匹配', ms: 300 })
      t.tool('Read', 'components/Card.tsx', { output: '64 行', ms: 200 })
    },
  })
  s.wait(48).say('思路：先把写死的颜色换成主题变量，再给 `.dark` 补一套取值；「记住登录」放进同一个表单。')
  s.tool('Edit', 'pages/Login.tsx', { input: '- <div className="bg-white p-8">\n+ <div className="bg-surface p-8 text-fg">\n- <input className="border-gray-200" />\n+ <input className="border-line" />\n+ <RememberMe days={7} />', changes: [ch('pages/Login.tsx', 3, 2)], ms: 1100 })
  s.tool('Edit', 'theme/tokens.css', { input: '+ .dark {\n+   --surface: #16171a;\n+   --fg: #ececee;\n+   --line: #2a2b30;\n+ }', changes: [ch('theme/tokens.css', 5)], ms: 600 })
  s.tool('Write', 'tests/login.spec.ts', { input: "test('深色下文字对比度 ≥ 4.5', …)\ntest('输入框聚焦有可见描边', …)\ntest('切换主题不闪白', …)\ntest('7 天内免登', …)", changes: [ch('tests/login.spec.ts', 4)], ms: 800 })
  s.prompt('claude', '补充 #g8b：登录页的按钮也顺便换成圆角。')
  s.tool('Edit', 'pages/Login.tsx', { input: '- <Button>登录</Button>\n+ <Button className="rounded-lg">登录</Button>', changes: [ch('pages/Login.tsx', 1, 1)], ms: 500 })
  s.prompt('claude', '补充 #g8d：深色背景用 #111，纯黑太刺眼。')
  s.tool('Edit', 'theme/tokens.css', { input: '-   --surface: #16171a;\n+   --surface: #111111;', changes: [ch('theme/tokens.css', 1, 1)], ms: 400 })
  const first = s.tool('Bash', 'pnpm test login', { input: 'pnpm test login', status: 'failed', output: 'FAIL 输入框聚焦有可见描边\n  expected outline-width > 0, received 0px\n  at tests/login.spec.ts:18\n\n3 passed, 1 failed (2.1s)', ms: 2100 })
  s.say('聚焦描边被全局 reset 里的 `outline: none` 盖掉了。在输入框上显式加 `focus:ring-2`，再跑一次。')
  s.tool('Edit', 'pages/Login.tsx', { input: '- <input className="border-line" />\n+ <input className="border-line focus:ring-2 focus:ring-fg/40" />', changes: [ch('pages/Login.tsx', 1, 1)], ms: 400 })
  s.tool('Bash', 'pnpm test login', { input: 'pnpm test login', status: 'running', retryOf: first, output: 'PASS 深色下文字对比度 ≥ 4.5 (412ms)\nPASS 输入框聚焦有可见描边 (88ms)\nPASS 切换主题不闪白 (203ms)\n… 7 天内免登 运行中' })
  s.deliver('登录页深色截图', 'file', 'shots/login-dark.png', '212 KB')
})

const keys = session({ computeId: 'keys', harness: 'claude-code', model: 'Claude Opus 5.5', start: '02:14:00' }, (s) => {
  s.prompt('claude', '给输入框加几个快捷键。来源：模型助手群聊 #g8k。')
  s.say('先列出要加的：\n- Cmd+K 打开搜索\n- Cmd+Enter 发送\n- Esc 关掉浮层')
  s.tool('Grep', '"onKeyDown" in src/components', { output: '2 处匹配\ncomponents/Composer.tsx:88\ncomponents/Search.tsx:41', ms: 300 })
  s.tool('Read', 'components/Composer.tsx', { output: '331 行。按键在 88 行的 onKeyDown 里手写判断', ms: 300 })
  s.tool('Glob', 'src/hooks/use*.ts', { output: 'src/hooks/use-toast.ts', ms: 100 })
  s.say('没有统一的快捷键入口。先写一个 `useHotkeys`，再把 Composer 里手写的判断换过去。')
  s.tool('Write', 'src/hooks/useHotkeys.ts', { input: 'export function useHotkeys(map: Record<string, (e: KeyboardEvent) => void>) { … }', changes: [ch('src/hooks/useHotkeys.ts', 38)], ms: 900 })
  s.tool('Edit', 'components/Composer.tsx', { status: 'running', input: "+ useHotkeys({ 'mod+k': openSearch, 'mod+enter': send, escape: closeOverlay })" })
})

const search = session({ computeId: 'search', harness: 'claude-code', model: 'Claude Opus 5.5', start: '02:14:00' }, (s) => {
  s.prompt('claude', '搜索结果带上 #seq，点了跳回原消息。来源：模型助手群聊 #g13a。')
  s.tool('Read', 'components/Overlays.tsx', { output: 'SearchPage 在 412 行，结果行只显示文字和发送人', ms: 400 })
  s.tool('Grep', '"jump(" in src', { output: '9 处匹配，定义在 App.tsx:318 jump(msgId)', ms: 300 })
  s.say('结果行加上 `#seq`，点击走已有的 `jump(msgId)`，跳过去后高亮那条消息。')
  s.tool('Edit', 'components/Overlays.tsx', { status: 'running', input: '+ <span className="tabular-nums text-fg-3">#{m.seq}</span>\n+ onClick={() => jump(m.id)}' })
})

const review = session({ computeId: 'review', harness: 'claude-code', model: 'Claude Opus 5.5', day: '2026-11-08', start: '18:20:00', end: '18:31:00' }, (s) => {
  s.prompt('claude', '复核一下验收文档，有问题直接改。来源：和 39impacts 的私聊 #d1。')
  s.tool('Read', 'docs/验收文档-v0.1.md', { output: '212 行，AC-01 到 AC-46', ms: 600 })
  s.say('逐条对照下来，有 5 处要改：\n- AC-14 停滞阈值写成了 5 分钟，应该是 10 分钟\n- AC-23「停止」没写确认停下前的状态\n- AC-36 失败只给了重试，少了换模型和跳过\n- AC-40 交代消息缺「谁来交代」\n- AC-45 改派活消息时要原位升版，不是另开')
  s.wait(60)
  s.tool('Edit', 'AC-14 停滞阈值', { changes: [ch('docs/验收文档-v0.1.md', 1, 1)], ms: 500 })
  s.tool('Edit', 'AC-23 停止中的状态', { changes: [ch('docs/验收文档-v0.1.md', 3, 1)], ms: 500 })
  const miss = s.tool('Edit', 'AC-36 失败后的三条路', { status: 'failed', input: 'old_string: 失败时给出「重试」按钮', output: 'String to replace not found in file.\n原文是「失败时给出重试按钮」，没有引号', ms: 300 })
  s.tool('Edit', 'AC-36 失败后的三条路', { retryOf: miss, input: 'old_string: 失败时给出重试按钮', changes: [ch('docs/验收文档-v0.1.md', 3, 1)], ms: 500 })
  s.tool('Edit', 'AC-40 谁来交代', { changes: [ch('docs/验收文档-v0.1.md', 2, 0)], ms: 400 })
  s.tool('Edit', 'AC-45 原位升版', { changes: [ch('docs/验收文档-v0.1.md', 2, 1)], ms: 400 })
  s.say('5 处都改好了，已合入。改动集中在 AC-14 / 23 / 36 / 40 / 45，别的条目没动。')
  s.deliver('验收文档 5 处修改', 'diff', 'docs/验收文档-v0.1.md')
})

export const codeSessions: Record<string, HarnessTranscript> = { login, keys, search, review }
