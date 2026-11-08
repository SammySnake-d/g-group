import type { PersonId } from '@/data'

/* 复制团队(群模板)的分组、步骤与固定说明(概念卡第 12 张;#1160 #1172 #1278) */

export type GroupKey = 'member' | 'rule' | 'flow' | 'lesson' | 'local'
export type Item = { id: string; group: GroupKey; text: string; src: string; who?: PersonId }

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
