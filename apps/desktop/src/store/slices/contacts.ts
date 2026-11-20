import type { Person, PersonId } from '@/data'
import { dropPerson, putPerson, replacePeople } from '../people'
import type { Slice } from '../state'

const listed = (p: Person) => !p.human && p.id !== 'helper' && p.id !== 'me'

export interface ContactsCtx {
  /** 通讯录里的联系人,按来源给的顺序;演示模式是演示联系人,连上后端是 contacts.list */
  contactIds: PersonId[]
}
export const CONTACTS_CTX_KEYS = ['contactIds'] as const satisfies readonly (keyof ContactsCtx)[]

export type ContactsSlice = ContactsCtx & {
  setContacts: (list: Person[]) => void
  upsertContact: (p: Person) => void
  dropContact: (id: PersonId) => void
}

export const createContactsSlice: Slice<ContactsSlice> = (set) => ({
  contactIds: [],
  setContacts: (list) => {
    replacePeople(list)
    set({ contactIds: list.filter(listed).map((p) => p.id) })
  },
  upsertContact: (p) => {
    putPerson(p)
    set((s) => ({ contactIds: !listed(p) || s.contactIds.includes(p.id) ? [...s.contactIds] : [...s.contactIds, p.id] }))
  },
  dropContact: (id) => {
    dropPerson(id)
    set((s) => ({ contactIds: s.contactIds.filter((x) => x !== id) }))
  },
})
