// 模型配置切片(D07.4):全局默认与模型目录;联系人设置改动在它的私聊里留一条记录。
import { people } from '@/data'
import { INITIAL_MODEL_SETTINGS } from '@/modelConfig'
import { uid } from '../boot'
import { lens, type Slice } from '../state'
import type { Ctx } from '../types'

export type ModelsSlice = Pick<Ctx, 'modelSettings' | 'modelsRev' | 'saveModels' | 'updatePerson'>

export const createModelsSlice: Slice<ModelsSlice> = (set, get) => {
  const L = lens(set)
  const sys = (cid: string, text: string) => get().pushMsg({ k: 'sys', id: 's' + uid(), text }, cid)
  const dmOf = (pid: string) => get().convs.find((c) => c.kind === 'dm' && c.members.includes(pid))

  return {
    modelSettings: INITIAL_MODEL_SETTINGS,
    modelsRev: 0,

    updatePerson: (pid, patch, note) => {
      Object.assign(people[pid], patch)
      const { convs, active } = get()
      const dm = dmOf(pid)
      const text = `你改了 ${people[pid].name} 的设置：${note}`
      if (dm) sys(dm.id, text)
      if (active !== dm?.id && convs.find((c) => c.id === active)?.members.includes(pid)) sys(active, text)
      get().toast('已保存')
    },
    saveModels: ({ settings, contacts, toast }) => {
      if (settings) L.modelSettings((m) => ({ ...m, ...settings }))
      for (const c of contacts ?? []) {
        Object.assign(people[c.id], c.patch)
        const dm = dmOf(c.id)
        if (dm) sys(dm.id, `你改了 ${people[c.id].name} 的设置：${c.note}`)
      }
      set((s) => ({ modelsRev: s.modelsRev + 1 }))
      get().toast(toast ?? '已保存')
    },
  }
}
