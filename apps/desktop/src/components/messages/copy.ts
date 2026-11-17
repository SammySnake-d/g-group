/* 消息模块自己的常量与文案(#932:不写死在组件里)。只放会被多处引用、或属于演示数据的那部分;
   一次性的按钮文字仍留在组件里,和交互写在一起更好读。 */
import { REACTION_EMOJI } from '@/config/emoji'
import type { DispKind } from '@/data'
import type { Live } from '@/components/Avatar'
import type { Bodied } from './types'

/** 右键菜单顶上那排表情:回应集合的前 5 个(完整集合在工具条的表情面板里) */
export const MENU_EMOJI = REACTION_EMOJI.slice(0, 5)

/** 头像菜单里联系人此刻的状态 */
export const LIVE_TEXT: Record<Live, string> = { idle: '空闲', running: '在干活', waiting: '在等你', error: '遇到问题' }

/** 引用非文字消息时,引用条上显示的占位 */
const QUOTE_PLACEHOLDER: Record<Exclude<Bodied['k'], 'text'>, string> = {
  compute: '[Compute]', file: '[文件]', board: '[任务板]', forward: '[转发]', vote: '[投票]', summary: '[总结]', authfix: '[授权提醒]',
}
/** 引用 / 回复一条消息时带进输入框的文字:正文去掉开头的 @某人;其它种类用占位 */
export const quoteText = (m: Bodied) => (m.k === 'text' ? m.text.replace(/^@\S+\s/, '') : QUOTE_PLACEHOLDER[m.k])

/** 交代不对时可以改成的三种 */
export const DISP_CHOICES: { kind: Extract<DispKind, 'doing' | 'committed' | 'noted'>; label: string }[] = [
  { kind: 'doing', label: '这是要做的事，去做' },
  { kind: 'committed', label: '记下来，以后照这个做' },
  { kind: 'noted', label: '只是说一下，知道就行' },
]

/** 演示数据:联系人截图的占位画面 */
export const SHOT_PLACEHOLDER = '短信验证码 · ● ● ● ● ● ●'

/** 提问卡片的状态字 */
export const ASK_STATUS = { live: '等你选', stale: '已过期 · 未执行', answered: (at?: string) => `你 ${at ?? ''} · 已选` }
