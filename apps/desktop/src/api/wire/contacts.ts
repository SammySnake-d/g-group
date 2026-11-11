// 联系人接线:contacts.list 全量读 → 联系人切片(整表替换);contact.updated / contact.removed 事件增量更新。
// 写:新建联系人(contacts.create,再按选的 Compute 个数 contacts.update),建好打开和它的私聊。
// 合同里没有头像形状和颜色(只有 avatar 图片地址,目前都是 null):按 id 稳定地挑一个,同一联系人每次打开都一样。
import type { ContactView } from '@g-group/api-contract'
import { SHAPES, SWATCHES, type Person } from '@/data'
import { openDmLive } from './rooms'
import { actionId, defineWiring, read, type WireCtx } from './types'

const hash = (s: string) => [...s].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7)

/** 合同的联系人 → 界面的联系人。花费、性格、记忆这些合同里没有的字段不填,界面按「没有」显示 */
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
    /* 整表替换:连上后端时登记表里只有后端的联系人(你自己和 Helper 由联系人切片补上) */
    w.get().setContacts(contacts.map(toPerson))
  },
  on: {
    'contact.updated': (ev, w) => w.get().upsertContact(toPerson(ev.contact)),
    'contact.removed': (ev, w) => w.get().dropContact(ev.contactId),
  },
})

/** 新建联系人:名字、擅长什么进合同;选的「最多同时分几个 Compute」用 contacts.update 存(contacts.create 没有这一项)。
 *  形象和颜色合同里存不下,连上后端时添加页不让选。建好打开和它的私聊 */
export async function createContactLive(w: WireCtx, p: { name: string; role: string; quota: number }) {
  const r = await w.call('contacts.create', { clientActionId: actionId(), name: p.name, ...(p.role ? { bio: p.role } : {}) })
  if (!r.ok) { w.get().toast(`没添加成联系人：${r.error.message}`); return }
  w.get().upsertContact(toPerson(r.value))
  const u = await w.call('contacts.update', { contactId: r.value.id, computeSlots: p.quota })
  if (u.ok) w.get().upsertContact(toPerson(u.value))
  else w.get().toast(`联系人加好了，但 Compute 个数没存上：${u.error.message}`)
  await openDmLive(w, r.value.id)
}
