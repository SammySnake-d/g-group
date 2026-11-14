// 联系人登记表:界面各处按 id 查联系人(名字、头像、模型…)都读这一张;组件仍从 '@/data' 引 people,指向的就是它。
// 内容只有两种来源:演示模式由 api/demo-state.ts 装演示联系人;连上后端由 api/wire/contacts.ts 装 contacts.list 的结果。
// 只经下面三个函数改,并且由 contacts 切片同时更新 contactIds——组件靠 contactIds 变化重渲染,直接改这张表界面不会刷新。
import { HELPER, SELF } from '@/config/identity'
import type { Person, PersonId } from '@/data'

export const people: Record<PersonId, Person> = { me: { ...SELF }, helper: { ...HELPER } }

/** 整表换掉;没给你自己和 Helper 时补上默认身份 */
export function replacePeople(list: Person[]) {
  for (const k of Object.keys(people)) delete people[k]
  people.me = { ...SELF }
  people.helper = { ...HELPER }
  for (const p of list) people[p.id] = p
}
export function putPerson(p: Person) { people[p.id] = p }
export function dropPerson(id: PersonId) { if (id !== 'me' && id !== 'helper') delete people[id] }
