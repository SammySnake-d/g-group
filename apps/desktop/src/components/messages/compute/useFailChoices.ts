/* 出错那一行上的几条路(AC-36):演示里是 重试 / 换个模型 / 跳过;连上后端时照失败卡上真有的选项来——
   没配备用模型就不出「换个模型」,「跳过」写成卡上的原话(不重试了),不编后端没有的路 */
import { findCard, isTaskFailure } from '@/api/wire/cards'
import { useApp } from '@/ctx'

export function useFailChoices(pid: string | undefined) {
  return useApp((s) => {
    const card = pid?.startsWith('card:') ? findCard(s.convs, (c) => c.id === pid.slice(5) && isTaskFailure(c))?.msg.card : undefined
    if (!card) return { switchable: true, switchLabel: '换个模型', skipLabel: '跳过' }
    const sw = card.actions.find((a) => a.id.startsWith('switch-model:'))
    const skip = card.actions.find((a) => a.id === 'give-up' || a.id === 'skip')
    return { switchable: !!sw, switchLabel: sw?.label ?? '', skipLabel: skip?.label ?? '跳过' }
  })
}
