// 演示模式的界面初值:浏览器预览(没有桌面壳)、或桌面壳里后端没起来时才装。连上后端时一概不装,界面只读后端(api/wire)。
// 演示数据(data.ts、store/demo.ts)只经这里进界面状态;演示服务(demo-server)的种子也在这里一起装,两边是同一份。
import type { StoreApi } from 'zustand'
import { provFixture } from '@/components/files/fixtures'
import { boards0, checklist0, commits0, computes0, convs0, crons0, demoPeople, pending0, playbook0, pluginCatalog0, plugins0, pulse0, reactions0 } from '@/data'
import { boot } from '@/store/boot'
import { DRAFTS0 } from '@/store/demo'
import { slashEntries } from '@/store/select'
import type { AppState } from '@/store/state'
import { installDemo } from './backend'
import { demoSeed } from './demo-seed'

let applied = false
/** 是否已装演示数据(装过就不再装第二遍) */
export const demoApplied = () => applied

export function applyDemo(store: StoreApi<AppState>) {
  if (applied) return
  applied = true
  const people = Object.values(demoPeople)
  store.getState().setContacts(people)
  const convs = provFixture(boot.provFixture, convs0)
  store.setState({
    convs, reactions: reactions0, drafts: DRAFTS0, unreadAt: Object.fromEntries(convs0.map((c) => [c.id, c.unread ?? 0])),
    computes: computes0, pending: pending0,
    boards: boards0, commits: commits0, playbook: playbook0, checklist: checklist0,
    crons: crons0, pulse: pulse0,
    plugins: plugins0, pluginCatalog: pluginCatalog0,
  })
  /* 没连上后端时 call() 交给演示服务;种子是同一份演示数据,命令清单按会话现算 */
  installDemo(demoSeed({
    people, crons: crons0, plugins: plugins0, catalog: pluginCatalog0,
    commands: (roomId) => {
      const s = store.getState()
      const conv = s.convs.find((c) => c.id === roomId)
      return conv ? slashEntries(s, conv).filter((e) => !e.disabled).map((e) => e.command) : []
    },
  }))
}
