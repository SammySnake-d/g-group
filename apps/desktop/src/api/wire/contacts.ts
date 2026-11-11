// 联系人接线(示范):contacts.list 全量读 → 联系人切片;contact.updated / contact.removed 事件增量更新。
// 合同里没有头像形状和颜色(只有 avatar 图片地址,目前都是 null):按 id 稳定地挑一个,同一联系人每次打开都一样。
import type { ContactView } from '@g-group/api-contract'
import { SHAPES, SWATCHES, type Person } from '@/data'
import { defineWiring, read } from './types'

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
    /* B0a:后端的联系人并进登记表,演示联系人先留着(界面其余部分还是演示数据,删了会断引用);B0b 改成整表替换 */
    for (const c of contacts) w.get().upsertContact(toPerson(c))
  },
  on: {
    'contact.updated': (ev, w) => w.get().upsertContact(toPerson(ev.contact)),
    'contact.removed': (ev, w) => w.get().dropContact(ev.contactId),
  },
})
