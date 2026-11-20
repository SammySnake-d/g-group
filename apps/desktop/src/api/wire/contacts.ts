import type { ContactView } from '@g-group/api-contract'
import { SHAPES, SWATCHES, type Person } from '@/data'
import { openDmLive } from './rooms'
import { actionId, defineWiring, read, type WireCtx } from './types'

const hash = (s: string) => [...s].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7)

export function toPerson(c: ContactView): Person {
  const h = hash(c.id)
  return {
    id: c.id, name: c.name, role: c.bio,
    shape: SHAPES[h % SHAPES.length], color: SWATCHES[(h >>> 8) % SWATCHES.length],
    model: c.speakingModel || undefined, harness: c.harness,
    computeModel: { mode: c.computeModel.mode, ...(c.computeModel.model ? { model: c.computeModel.model } : {}), ...(c.computeModel.effort ? { effort: c.computeModel.effort } : {}) },
    ...(c.computeSlots ? { computeQuota: c.computeSlots } : {}),
    tools: c.computeAssets.map((a) => ({ name: a.name, on: true, kind: a.kind === 'mcp' ? 'mcp' : 'skill' })),
  }
}

export const contactsWiring = defineWiring({
  entity: '联系人',
  load: async (w) => {
    const { contacts } = await read(w, 'contacts.list', {})
    w.get().setContacts(contacts.map(toPerson))
  },
  on: {
    'contact.updated': (ev, w) => w.get().upsertContact(toPerson(ev.contact)),
    'contact.removed': (ev, w) => w.get().dropContact(ev.contactId),
  },
})

export async function createContactLive(w: WireCtx, p: { name: string; role: string; quota: number }) {
  const r = await w.call('contacts.create', { clientActionId: actionId(), name: p.name, ...(p.role ? { bio: p.role } : {}) })
  if (!r.ok) { w.get().toast(`没添加成联系人：${r.error.message}`); return }
  w.get().upsertContact(toPerson(r.value))
  const u = await w.call('contacts.update', { contactId: r.value.id, computeSlots: p.quota })
  if (u.ok) w.get().upsertContact(toPerson(u.value))
  else w.get().toast(`联系人加好了，但 Compute 个数没存上：${u.error.message}`)
  await openDmLive(w, r.value.id)
}
