// 联系人切片:通讯录列出谁(contactIds)。资料本身在登记表 store/people.ts;这一片负责「登记表 + 列表」一起换,组件才会跟着重渲染。
// 写入方:演示模式 api/demo-state.ts(整表);连上后端 api/wire/contacts.ts(全量读 + contact.updated / contact.removed 事件)。
import type { Person, PersonId } from '@/data'
import { dropPerson, putPerson, replacePeople } from '../people'
import type { Slice } from '../state'

/** 通讯录只列联系人:不含你自己、Helper 和群里的真人 */
const listed = (p: Person) => !p.human && p.id !== 'helper' && p.id !== 'me'

/** 这一片经 useApp() 对外暴露的字段(Ctx 的一部分)。加字段:写在这里,再把名字加进下面的 CONTACTS_CTX_KEYS */
export interface ContactsCtx {
  /** 通讯录里的联系人,按来源给的顺序;演示模式是演示联系人,连上后端是 contacts.list */
  contactIds: PersonId[]
}
export const CONTACTS_CTX_KEYS = ['contactIds'] as const satisfies readonly (keyof ContactsCtx)[]

export type ContactsSlice = ContactsCtx & {
  /** 整表换掉(演示数据装入、后端全量读);你自己和 Helper 一直保留 */
  setContacts: (list: Person[]) => void
  /** 新增或更新一位(contact.updated 事件、新建回包、本地新建) */
  upsertContact: (p: Person) => void
  /** 删掉一位(contact.removed 事件) */
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
    /* 已在列表里也换一个新数组:改名、换头像后列表要重渲染 */
    set((s) => ({ contactIds: !listed(p) || s.contactIds.includes(p.id) ? [...s.contactIds] : [...s.contactIds, p.id] }))
  },
  dropContact: (id) => {
    dropPerson(id)
    set((s) => ({ contactIds: s.contactIds.filter((x) => x !== id) }))
  },
})
