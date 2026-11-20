import type { Msg } from '@/data'

export type Bodied = Exclude<Msg, { k: 'date' | 'sys' | 'huddle' | 'commit' | 'asset' | 'replying' }>
export type TextMsg = Extract<Msg, { k: 'text' }>
export type MsgOf<K extends Msg['k']> = Extract<Msg, { k: K }>
