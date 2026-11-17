import type { Msg } from '@/data'

/** 有发送人、走气泡行(Row)的消息;日期、系统行、讨论、承诺、资产提示、正在回复卡各走自己的居中行 */
export type Bodied = Exclude<Msg, { k: 'date' | 'sys' | 'huddle' | 'commit' | 'asset' | 'replying' }>
export type TextMsg = Extract<Msg, { k: 'text' }>
export type MsgOf<K extends Msg['k']> = Extract<Msg, { k: K }>
