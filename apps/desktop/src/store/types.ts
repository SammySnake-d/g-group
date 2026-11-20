// 界面状态的领域类型(原 ctx.ts)。ctx.ts 继续原样导出这些类型,外部 import 不用改。
import type { PersonId } from '@/data'
import type { LayoutCtx } from './slices/layout'
import type { ChatCtx } from './slices/chat'
import type { MessagesCtx } from './slices/messages'
import type { MembersCtx } from './slices/members'
import type { ComputeCtx } from './slices/compute'
import type { TasksCtx } from './slices/tasks'
import type { ScheduleCtx } from './slices/schedule'
import type { PluginsCtx } from './slices/plugins'
import type { ModelsCtx } from './slices/models'
import type { ContactsCtx } from './slices/contacts'

export type Page =
  | { t: 'person'; id: PersonId }
  | { t: 'personTools'; id: PersonId }
  | { t: 'inner'; id: PersonId; conv: string }
  | { t: 'detail'; id: PersonId; conv: string; tab?: 'me' | 'agents' | 'work' | 'memory' }
  | { t: 'talk'; id: string }
  | { t: 'workspace'; id: string }
  | { t: 'pins'; id: string }
  | { t: 'members'; id: string }
  | { t: 'files'; id: string }
  | { t: 'group'; id: string }
  | { t: 'pool'; id: string }
  | { t: 'links'; id: string }
  | { t: 'linkPick'; id: string }
  | { t: 'playbook'; id: string }
  | { t: 'commits'; id: string }
  | { t: 'clone'; id: string }
  | { t: 'search'; id: string }
  | { t: 'huddle'; conv: string; msgId: string }
  | { t: 'forwardView'; conv: string; msgId: string }
  | { t: 'forwardPick'; from: string; msgIds: string[] }
  | { t: 'helper' }
  | { t: 'settings' }
  | { t: 'addContact' }
  | { t: 'newGroup' }
  | { t: 'sources' }
  | { t: 'source'; id: string }
  | { t: 'process'; id: PersonId; conv?: string }
  | { t: 'cron'; id: string }
  | { t: 'task'; id: string }

export type SplitTab = { t: 'compute'; id: string; view?: CView } | { t: 'artifact'; id: string } | { t: 'contact'; id: PersonId; conv?: string; tab?: 'here' | 'talks' | 'process' | 'duty' | 'memory' } | { t: 'cron'; id: string } | { t: 'group'; id: string; tab?: 'members' | 'notice' | 'list' | 'cron' | 'plugin' | 'tools' }
/** Compute 视图页签;'session' = harness 原始会话(#1005,默认选中) */
export type CView = 'session' | 'activity' | 'diff' | 'preview' | 'checks' | 'checkpoints'

export interface Answer { title: string; options: string[]; picked: string; at: string; replyId: string }

/** 业务组件经 useApp() 看到的全部字段 = 各切片对外字段之和。各片在自己的切片文件里声明(XxxCtx),这里不再逐个列 */
export type Ctx = LayoutCtx & ChatCtx & MessagesCtx & MembersCtx & ComputeCtx & TasksCtx & ScheduleCtx & PluginsCtx & ModelsCtx & ContactsCtx

export interface ScheduleDraft { conv: string; when?: string; what?: string; via: 'slash' }

export type Section = 'chat' | 'contacts' | 'activity' | 'files' | 'plugins'
export type WbTab = 'overview' | 'duty' | 'memory' | 'cron' | 'settings' | 'process'

