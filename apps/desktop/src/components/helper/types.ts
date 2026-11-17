import type { PersonId } from '@/data'

/* 面板里的确认卡:另开一个群 / 把 CSV 转成本群清单 */
export type GroupCard = { title: string; picks: Record<PersonId, boolean>; bg: { id: string; text: string; on: boolean }[]; done?: string }
export type CsvCard = { rows: { text: string; who?: PersonId; why: string }[]; done?: boolean }

/** 面板对话的一条:普通话,或者带一张确认卡 */
export type PItem =
  | { id: string; from: 'me' | 'helper'; text: string }
  | { id: string; from: 'helper'; text: string; group: GroupCard }
  | { id: string; from: 'helper'; text: string; csv: CsvCard }

/* 全局 Helper:读之前先问(授权卡),发之前先给草稿(草稿卡) */
export type Grant = { conv: string; title: string; n: number; ask: string; state?: 'yes' | 'no' }
export type Draft = { conv: string; title: string; body: string; state?: 'sent' | 'cancel' }
export type GItem =
  | { id: string; from: 'me' | 'helper'; text: string }
  | { id: string; from: 'helper'; text: string; grant: Grant }
  | { id: string; from: 'helper'; text: string; draft: Draft }
export type GrantItem = Extract<GItem, { grant: unknown }>
export type DraftItem = Extract<GItem, { draft: unknown }>
