import type { PersonId } from '@/data'

/* 复制团队(群模板)的分组、步骤与固定说明(概念卡第 12 张;#1160 #1172 #1278) */

export type GroupKey = 'member' | 'rule' | 'flow' | 'lesson' | 'local'
/** readonly:只读展示、不能取消勾选(连着后端时成员的预设:跟着联系人本人走,不是从这个群带过去的) */
export type Item = { id: string; group: GroupKey; text: string; src: string; who?: PersonId; readonly?: boolean }

export const GROUPS: { key: GroupKey; title: string; desc: string }[] = [
  { key: 'member', title: '成员', desc: '每位助手写给自己看的工作方式和会的技能，跟着它本人走' },
  { key: 'rule', title: '群规', desc: '群公告里的规矩，每句一条' },
  { key: 'flow', title: '配合方式', desc: '这个团队怎么分工、怎么交接' },
  { key: 'lesson', title: '经验', desc: '被纠正过、到哪都该记住的事' },
  { key: 'local', title: '只在这个项目用（默认不带）', desc: '这些事实只对原来的项目成立，换了项目多半不对' },
]

export const STEPS = ['起名并选成员', '检查要带走的规则和经验', '确认'] as const

/** 无论怎么勾都不会带过去的项目内容 */
export const NEVER_CARRIED = ['全部聊天消息', '文件和资产（含服务器账号）', '在做和做完的任务与清单']

/* ---------- 连着后端 ----------
   群规读这个群现在有效的公告(conv.notices,一条公告一项,新群里逐条发布);成员的预设读后端(contacts.profile),只读;
   协作手册合同里没有、用户定以后再定:不列配合方式 / 经验 / 只在这个项目用这三组,把这句写在页上 */
export const GROUPS_LIVE: { key: GroupKey; title: string; desc: string }[] = [
  { key: 'member', title: '成员的预设（只读）', desc: '每位联系人自己的预设，读自后端；它跟着联系人本人走，进新群还是这一份' },
  { key: 'rule', title: '群公告', desc: '这个群现在有效的公告，一条一项；勾上的会在新群里逐条发布' },
]
export const STEPS_LIVE = ['起名并选成员', '检查要带走的群公告', '确认'] as const
export const CLONE_LIVE = {
  playbookLater: '协作手册以后再定：现在不带配合方式和经验，只带成员和群公告。',
  noNotices: '这个群还没有群公告，新群只带成员。',
  pickHint: '公告默认都带上，不想带的取消勾选。成员的预设只是给你看一眼，不用带。',
  laterTitle: '以后再定',
  laterLines: ['协作手册（配合方式和经验）'],
  personaSrc: '预设 · 读自后端',
  personaLoading: '正在读预设…',
  personaEmpty: '还没写预设',
  personaFailed: (reason: string) => `预设没读到：${reason}`,
  creating: '正在创建…',
} as const
