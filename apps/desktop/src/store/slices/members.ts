// 群与成员切片:建群、加人、踢人、关联会话、置顶/免打扰、拍一拍、禁言、群算力、退出/解散、撤下公告、新建联系人。
// 连上后端时改走接线层(api/wire/rooms、notices):以后端回包和事件为准;移出成员、解散群碰上在途任务,后端拒绝并列出,
// 写进 groupAsk 由界面问你「先停下再移出 / 解散」。
import { people, poolUsed, type PersonId } from '@/data'
import { createContactLive } from '@/api/wire/contacts'
import { live, liveCtx } from '@/api/wire/live'
import { removeNoticeLive } from '@/api/wire/notices'
import { addMembersLive, createGroupLive, dissolveLive, pokeLive, removeMemberLive, updateRoomLive } from '@/api/wire/rooms'
import { broken } from '@/mut'
import { uid } from '../boot'
import { lens, type Slice } from '../state'

/** 后端因在途任务拒绝了移出成员 / 解散群:界面据此问你要不要先停下这些事(tasks 是任务标题) */
export type GroupAsk = { kind: 'remove'; conv: string; who: PersonId; tasks: string[] } | { kind: 'dissolve'; conv: string; tasks: string[] }

/** 这一片经 useApp() 对外暴露的字段(Ctx 的一部分)。加字段:写在这里,再把名字加进下面的 MEMBERS_CTX_KEYS */
export interface MembersCtx {
  addMembers: (convId: string, ids: PersonId[], by?: PersonId) => void
  /** 移出成员;stopTasks = 你已确认先停下它在本群在做的事(AC-49) */
  removeMember: (convId: string, id: PersonId, opts?: { stopTasks?: boolean }) => void
  groupAsk: GroupAsk | null
  setGroupAsk: (a: GroupAsk | null) => void
  /** 撤下一条群公告(助手下一轮不再装配它) */
  removeNotice: (convId: string, noticeId: string) => void
  createContact: (p: { name: string; role: string; shape: string; color: string; model: string; quota: number }) => void
  createGroup: (title: string, ids: PersonId[], sys?: string, pool?: number) => string
  linkConv: (convId: string, other: string) => void
  unlinkConv: (convId: string, other: string) => void
  setConvFlag: (convId: string, flag: 'pinned' | 'muted', v: boolean) => void
  poke: (id: PersonId) => void
  silence: (convId: string, id: PersonId) => void
  /** U09：群主设本群临时算力上限（0 = 不给） */
  setPool: (convId: string, max: number) => void
  leaveConv: (id: string, dissolve: boolean, opts?: { stopTasks?: boolean }) => void
}
export const MEMBERS_CTX_KEYS = ['addMembers', 'removeMember', 'groupAsk', 'setGroupAsk', 'removeNotice', 'createContact', 'createGroup', 'linkConv', 'unlinkConv', 'setConvFlag', 'poke', 'silence', 'setPool', 'leaveConv'] as const satisfies readonly (keyof MembersCtx)[]

export type MembersSlice = MembersCtx

export const createMembersSlice: Slice<MembersSlice> = (set, get) => {
  const L = lens(set)
  const sys = (cid: string, text: string) => get().pushMsg({ k: 'sys', id: 's' + uid(), text }, cid)
  const names = (ids: PersonId[]) => ids.map((i) => people[i].name).join('、')
  const titleOf = (cid: string) => get().convs.find((c) => c.id === cid)?.title

  return {
    createGroup: (title, ids, note, pool) => {
      /* 连上后端:由后端建群(会话 id 等回包),建好切过去;这里先返回空 */
      if (live(get())) { void createGroupLive(liveCtx(get, set), title, ids, pool); return '' }
      const cid = 'g-' + uid()
      L.convs((cs) => [{ id: cid, kind: 'group', title, members: ['me', ...ids], time: '刚刚', links: [], tempCompute: pool ? { max: pool } : undefined, messages: [{ k: 'sys', id: 'n' + uid(), text: note ?? `你创建了群聊，拉进了 ${names(ids)}` }] }, ...cs])
      set({ section: 'chat', active: cid })
      return cid
    },
    createContact: (p) => {
      if (live(get())) { void createContactLive(liveCtx(get, set), { name: p.name, role: p.role, quota: p.quota }); return }
      const id = 'c-' + uid()
      /* 经联系人切片登记:登记表和通讯录列表一起更新 */
      get().upsertContact({ id, name: p.name, role: p.role, shape: p.shape, color: p.color, model: p.model, harness: get().modelSettings.defaultHarness, computeModel: { mode: 'inherit' }, computeQuota: p.quota, today: '¥0', month: '¥0', tools: people.claude?.tools?.map((t) => ({ ...t, on: false })) })
      const cid = 'dm-' + id
      L.convs((cs) => [{ id: cid, kind: 'dm', title: p.name, members: ['me', id], time: '刚刚', messages: [{ k: 'sys', id: 'n' + uid(), text: `你添加了 ${p.name}` }, { k: 'text', id: 'h' + uid(), from: id, text: `你好，我是 ${p.name}，${p.role}。有活直接说。` }] }, ...cs])
      set({ section: 'chat', active: cid, stack: [] })
    },
    addMembers: (cid, ids, by) => {
      if (live(get())) { void addMembersLive(liveCtx(get, set), cid, ids); return }
      L.convs((cs) => cs.map((c) => (c.id === cid ? { ...c, members: [...c.members, ...ids.filter((i) => !c.members.includes(i))] } : c)))
      sys(cid, `${by === 'helper' ? 'Helper 按你的要求' : '你'}把 ${names(ids)} 拉进了群`)
    },
    groupAsk: null,
    setGroupAsk: (groupAsk) => set({ groupAsk }),
    removeNotice: (cid, nid) => {
      const n = get().convs.find((c) => c.id === cid)?.notices?.find((x) => x.id === nid)
      if (live(get())) { if (n) void removeNoticeLive(liveCtx(get, set), cid, nid, n.ver); return }
      L.convs((cs) => cs.map((c) => (c.id === cid ? { ...c, notices: (c.notices ?? []).filter((x) => x.id !== nid) } : c)))
      if (n) sys(cid, `你撤下了群公告：${n.text.split('\n')[0]}`)
    },
    removeMember: (cid, id, opts) => {
      if (live(get())) {
        set({ groupAsk: null })
        void removeMemberLive(liveCtx(get, set), cid, id, !!opts?.stopTasks).then((r) => { if (!r.ok) set({ groupAsk: { kind: 'remove', conv: cid, who: id, tasks: r.tasks } }) })
        return
      }
      L.convs((cs) => cs.map((c) => (c.id === cid ? { ...c, members: c.members.filter((m) => m !== id) } : c)))
      /* U09:踢人时它借的群算力先停再还,不带走 */
      const held = Object.values(get().computes).filter((c) => c.conv === cid && c.owner === id && c.pool === 'group' && (c.status === 'running' || c.status === 'waiting'))
      if (held.length) L.computes((cs) => { const n = { ...cs }; held.forEach((c) => { n[c.id] = { ...c, status: 'stopped', phase: '已停止 · 群算力已归还' } }); return n })
      sys(cid, `你把 ${people[id].name} 移出了群${held.length ? `，它借的 ${held.length} 格群算力已停下并归还` : ''}`)
    },
    linkConv: (cid, other) => {
      L.convs((cs) => cs.map((c) => (c.id === cid ? { ...c, links: [...(c.links ?? []), other] } : c)))
      sys(cid, `你把「${titleOf(other)}」关联到了这里，助手回答时可以参考那边的记录`)
    },
    unlinkConv: (cid, other) => {
      L.convs((cs) => cs.map((c) => (c.id === cid ? { ...c, links: (c.links ?? []).filter((l) => l !== other) } : c)))
      sys(cid, `你取消了和「${titleOf(other)}」的关联`)
    },
    setConvFlag: (cid, flag, v) => {
      const done = flag === 'pinned' ? (v ? '已置顶' : '已取消置顶') : v ? '已开启消息免打扰' : '已关闭消息免打扰'
      if (live(get())) { void updateRoomLive(liveCtx(get, set), cid, flag === 'pinned' ? { pinned: v } : { muted: v }, done); return }
      L.convs((cs) => cs.map((c) => (c.id === cid ? { ...c, [flag]: v } : c)))
      get().toast(flag === 'pinned' ? (v ? '已置顶' : '已取消置顶') : v ? '已开启消息免打扰' : '已关闭消息免打扰')
    },
    poke: (id) => {
      const { active } = get()
      if (live(get())) { void pokeLive(liveCtx(get, set), active, id); return }
      sys(active, `你拍了拍 ${people[id].name}`)
      get().say(active, id, '在的，我看一眼最新消息。', 800)
    },
    silence: (cid, id) => {
      const on = !get().convs.find((c) => c.id === cid)?.silenced?.[id]
      L.convs((cs) => cs.map((c) => {
        if (c.id !== cid) return c
        const rest = Object.fromEntries(Object.entries(c.silenced ?? {}).filter(([k]) => k !== id))
        return { ...c, silenced: on ? { ...rest, [id]: '30 分钟' } : rest }
      }))
      sys(cid, on ? `你禁言了 ${people[id].name} 30 分钟。它后台在做的事不会停，做完会等禁言结束再汇报` : `你解除了 ${people[id].name} 的禁言`)
    },
    setPool: (cid, max) => {
      const used = poolUsed(get().computes, cid)
      if (broken('AC-09')) return
      if (live(get())) {
        void updateRoomLive(liveCtx(get, set), cid, { tempComputeSlots: max }, max > 0 ? `本群临时算力设为 ${max} 格${used > max ? `；借出的 ${used} 格做完就收回，不再借新的` : ''}` : `关掉了本群临时算力${used ? `；借出的 ${used} 格做完就收回` : ''}`)
        return
      }
      L.convs((cs) => cs.map((c) => (c.id === cid ? { ...c, tempCompute: max > 0 ? { max } : undefined } : c)))
      sys(cid, max > 0 ? `你把本群临时算力设为 ${max} 格${used > max ? `；现在借出 ${used} 格，多出的做完就收回，不再借新的` : ''}` : `你关掉了本群临时算力${used ? `；借出的 ${used} 格做完就收回` : ''}`)
    },
    /* #32:群主可以解散(所有人都没有这个群了,定时一起停),成员只能退出(只是你看不到了,助手们还在群里继续) */
    leaveConv: (id, dissolve, opts) => {
      if (live(get())) {
        /* 你是每个群的群主:群主不单独退出,要离开就解散 */
        if (!dissolve) { get().toast('你是群主：群主不能只退出，要离开就解散这个群'); return }
        set({ groupAsk: null })
        void dissolveLive(liveCtx(get, set), id, !!opts?.stopTasks).then((r) => {
          if (r.ok) set({ stack: [] })
          else set({ groupAsk: { kind: 'dissolve', conv: id, tasks: r.tasks } })
        })
        return
      }
      const { convs, computes } = get()
      const c = convs.find((x) => x.id === id)
      L.convs((cs) => cs.filter((x) => x.id !== id))
      if (dissolve) L.crons((l) => l.filter((x) => x.conv !== id))
      /* U09:解散时本群借出的算力全部停下归还 */
      const held = dissolve ? Object.values(computes).filter((x) => x.conv === id && x.pool === 'group' && (x.status === 'running' || x.status === 'waiting')) : []
      if (held.length) L.computes((cs) => { const n = { ...cs }; held.forEach((x) => { n[x.id] = { ...x, status: 'stopped', phase: '已停止 · 群已解散，算力已归还' } }); return n })
      set({ stack: [], tabs: [] })
      const next = convs.find((x) => x.id !== id)
      if (next) set({ active: next.id })
      get().toast(dissolve ? `已解散「${c?.title}」，群里的定时也一起停了${held.length ? `，借出的 ${held.length} 格算力已归还` : ''}` : `已退出「${c?.title}」`)
    },
  }
}
