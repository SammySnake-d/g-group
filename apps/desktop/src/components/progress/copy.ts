import type { BoardRange, BucketFilter, ReasonClass, SubKind } from '@g-group/ui-core'

/* 进展全景的界面文案(状态块、原因人话、子任务类别、时间范围、列标题)。逻辑在 @g-group/ui-core 的 board.ts。 */

export const TITLE = '进展全景'
export const SUBTITLE = '每个群和私聊里，联系人开了哪些 Compute，跑到哪了。点哪一项就打开哪里。'

export const TILE_LABEL: Record<BucketFilter, string> = { all: 'Compute', wait: '等你处理', run: '进行中', failed: '失败', stopped: '已停止', done: '已完成' }

/** 画板上的人话(D26 §8.4「画板上写」一列) */
export const REASON_TEXT: Record<ReasonClass, string> = {
  upstream_unavailable: '上游不可用', rate_limited: '被限流', no_response: '上游没回应', stream_dropped: '上游一直断流',
  stalled: '卡住无进展', context_overflow: '上下文超长，压缩失败', auth_or_quota: '鉴权或额度问题', invalid_request: '请求被拒',
  harness_crashed: '执行器崩溃', session_lost: '原会话找不到', platform_refused: '平台拒绝', user_stopped: '已停止', unknown: '未识别的失败',
}

export const SUB_KIND_LABEL: Record<SubKind, string> = { subagent: '子代理', subchat: '子对话', job: '后台任务' }

export const RANGE_LABEL: Record<BoardRange, string> = { today: '今天', '7d': '7 天', '30d': '30 天', all: '全部时间' }
export const GROUP_LABEL = { room: '按对话', contact: '按联系人' } as const

export const COLUMN = { room: '对话', contact: '联系人', cards: 'Compute', inside: '子代理 · 子对话 · 后台任务' } as const

export const STATS = { turns: '总轮数', subsRunning: '子任务在跑' } as const
export const SEARCH_PLACEHOLDER = '搜索群、联系人、任务'
export const EMPTY = { title: '这段时间没有符合条件的 Compute', reset: '全部时间' } as const
export const DM_SOURCE = '私聊'
export const MORE = (n: number) => `还有 ${n} 个`
export const FOLD = '收起'
