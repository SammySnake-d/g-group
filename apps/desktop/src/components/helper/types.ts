import type { PersonId } from '@/data'

export type GroupCard = { title: string; picks: Record<PersonId, boolean>; bg: { id: string; text: string; on: boolean }[]; done?: string }
export type CsvCard = { rows: { text: string; who?: PersonId; why: string }[]; done?: boolean }

export type PItem =
  | { id: string; from: 'me' | 'helper'; text: string }
  | { id: string; from: 'helper'; text: string; group: GroupCard }
  | { id: string; from: 'helper'; text: string; csv: CsvCard }

export type Grant = { conv: string; title: string; n: number; ask: string; state?: 'yes' | 'no' }
export type Draft = { conv: string; title: string; body: string; state?: 'sent' | 'cancel' }
export type GItem =
  | { id: string; from: 'me' | 'helper'; text: string }
  | { id: string; from: 'helper'; text: string; grant: Grant }
  | { id: string; from: 'helper'; text: string; draft: Draft }
export type GrantItem = Extract<GItem, { grant: unknown }>
export type DraftItem = Extract<GItem, { draft: unknown }>
