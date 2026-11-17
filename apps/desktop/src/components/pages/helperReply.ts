import type { Ctx } from '@/ctx'
import { HELPER_PAGE as H } from './constants'

/* 浮层 Helper 页的演示回复:按关键词出一张确认卡,或打开新建联系人。纯推导,不碰 React。 */
export type HelperCard = { title: string; lines: readonly string[]; action: () => void; done?: boolean }
export type HelperMsg = { from: 'me' | 'helper'; text: string; card?: HelperCard }

export function helperReply(t: string, ctx: Ctx, convTitle: string | undefined): { reply: HelperMsg; openContact?: boolean } {
  if (/拉|加/.test(t) && /Grok/i.test(t))
    return { reply: { from: 'helper', text: H.confirm, card: { title: `把 Grok 拉进「${convTitle}」`, lines: H.inviteLines, action: () => ctx.addMembers(ctx.active, [H.invite], 'helper') } } }
  if (/CSV|csv|任务表|任务板/.test(t))
    return { reply: { from: 'helper', text: H.csvRead, card: { title: `在「${convTitle}」建任务认领板`, lines: H.csvLines, action: () => ctx.importBoard(ctx.active) } } }
  if (/关联/.test(t))
    return { reply: { from: 'helper', text: H.confirm, card: { title: `把「Claude Code」私聊关联到「${convTitle}」`, lines: H.linkLines, action: () => ctx.linkConv(ctx.active, H.linkDm) } } }
  if (/联系人|助手/.test(t)) return { reply: { from: 'helper', text: H.openedContact }, openContact: true }
  return { reply: { from: 'helper', text: H.fallback } }
}
