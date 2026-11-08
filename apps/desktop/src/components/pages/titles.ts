import { people, sources } from '@/data'
import type { Page } from '@/ctx'

/* 浮层每一页的标题(返回按钮上显示上一页的标题) */
export function pageTitle(p: Page, convs: { id: string; title: string }[]): string {
  const ct = (id: string) => convs.find((c) => c.id === id)?.title ?? ''
  switch (p.t) {
    case 'person': return people[p.id]?.name ?? '资料'
    case 'personTools': return '技能和工具'
    case 'inner': return `${people[p.id].name} · 在${ct(p.conv)}`
    case 'detail': return `${people[p.id].name} · 对话细节`
    case 'talk': return '助手之间的对话'
    case 'workspace': return '工作区'
    case 'pins': return '置顶消息'
    case 'members': return '群成员'
    case 'files': return '群文件'
    case 'group': return '群设置'
    case 'pool': return '本群临时算力'
    case 'links': return '关联的会话'
    case 'linkPick': return '选要关联的会话'
    case 'playbook': return '群协作手册'
    case 'commits': return '大家记下的事'
    case 'clone': return '复制这个团队'
    case 'search': return '查找聊天记录'
    case 'huddle': return '助手之间的讨论'
    case 'forwardView': return '转发的记录'
    case 'forwardPick': return '转发到'
    case 'helper': return 'Helper'
    case 'settings': return '设置'
    case 'addContact': return '添加联系人'
    case 'newGroup': return '发起群聊'
    case 'sources': return '外部来源'
    case 'source': return sources.find((s) => s.id === p.id)?.app ?? '外部来源'
    case 'process': return `${people[p.id].name} · 完整过程`
    case 'cron': return '定时'
    case 'task': return '清单项'
  }
}

/** 页面身份:同一页参数不变就不重挂载;压栈/换页才重挂载(新页从前进方向进来) */
export const pageKey = (p: Page, depth: number) => `${depth}:${JSON.stringify(p)}`
