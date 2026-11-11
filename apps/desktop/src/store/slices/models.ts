// 模型配置切片(D07.4):全局默认与模型目录;联系人设置改动在它的私聊里留一条记录。
import { people, type PersonId } from '@/data'
import { INITIAL_MODEL_SETTINGS } from '@/modelConfig'
import { uid } from '../boot'
import { lens, type Slice } from '../state'

/** 这一片经 useApp() 对外暴露的字段(Ctx 的一部分)。加字段:写在这里,再把名字加进下面的 MODELS_CTX_KEYS */
export interface ModelsCtx {
  /** 模型配置（D07.4）：全局默认与模型目录。全软件只在设置页「默认」和联系人工作台「设置」两处改 */
  modelSettings: import('@/modelConfig').ModelSettings
  /** 每保存一次模型配置 +1：别处打开着的配置页据此刷新 */
  modelsRev: number
  /** 一次写入：全局默认 + 若干联系人的模型字段（每位联系人在私聊里留一条记录） */
  saveModels: (s: { settings?: Partial<import('@/modelConfig').ModelSettings>; contacts?: { id: PersonId; patch: Partial<import('@/data').Person>; note: string }[]; toast?: string }) => void
  updatePerson: (id: PersonId, patch: Partial<import('@/data').Person>, note: string) => void
}
export const MODELS_CTX_KEYS = ['modelSettings', 'modelsRev', 'saveModels', 'updatePerson'] as const satisfies readonly (keyof ModelsCtx)[]

export type ModelsSlice = ModelsCtx

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
