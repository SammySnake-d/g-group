// 演示数据:原型里模拟后端推进用的脚本与预置文字。接上真后端后由事件流替代,不进业务组件。
import type { Activity, PersonId } from '@/data'

/** 预置草稿:演示「列表里显示 [草稿]」 */
export const DRAFTS0: Record<string, string> = { 'dm-argon': '第 3 版里外部来源那节我还有个问题' }

/** 登录页深色这件 Compute 的推进脚本:每拍追加一条过程,最后一拍收尾并在群里汇报 */
export const LIVE: { phase: string; step: number; act: Omit<Activity, 'id' | 'step' | 'at'> }[] = [
  { phase: '跑测试', step: 2, act: { kind: 'cmd', title: 'pnpm test login', detail: '✓ 深色下文字对比度 ≥ 4.5 (412ms)\n✓ 输入框聚焦有可见描边 (88ms)\n✓ 切换主题不闪白 (203ms)\n✓ 7 天内免登 (1.2s)\n\n4 passed', dur: '2.1 秒' } },
  { phase: 'Astra 正在复核', step: 3, act: { kind: 'review', who: 'astra', title: 'Astra 换 GPT-6 复核：对比度、聚焦描边、免登都复现通过' } },
]
/** 推进间隔(毫秒,?speed= 可加快) */
export const LIVE_TICK_MS = 7000
export const LIVE_DONE_TEXT = '@39impacts 登录页做完了：深色主题、7 天免登，测试全部通过，Astra 复核过，可以验收了。'
/** 坏实现 AC-40-8 冒充发言的 Compute 身份(只为不让页面因未知发送人崩掉) */
export const ROGUE_COMPUTE = { id: 'login', name: 'Compute · 登录页深色', shape: 'chat', role: 'Compute' }

/** /总结 的演示结果 */
export const SUMMARY_DEMO = {
  title: '你离开的这段时间（01:30 – 02:14）',
  items: [
    { text: 'Codex 修好了首页慢：首屏 3.1 秒 → 0.9 秒，@你说可以验收了', ref: 'g6' },
    { text: 'Claude Code 在做登录页深色，正在跑测试', ref: 'g9' },
    { text: 'Claude Code、Codex 记下了“有进度就 @ 你”', ref: 'g9d' },
    { text: 'Argon 和 Claude Code 讨论了外部聊天记录怎么接，等你选方式', ref: 'g12' },
  ],
}

/** 导入任务板的演示行,以及谁领了哪行 */
export const IMPORTED_BOARD = { title: '导入的任务板', rows: ['登录页深色', '首页性能', '飞书接入方案', '设计规范'], claims: ['claude', 'codex', 'argon'] as PersonId[] }

/** Helper 在聊天里被 @ 时的演示卡片 */
export const HELPER_CARDS = {
  csv: ['飞书接入方案', '设计规范 v1', '插件中心原型', '定时总览'],
  group: ['新群：外部聊天记录接入', '拉：Claude Code、Argon', '背景：带上 #g10–#g12 三条'],
}

/** 推进脚本最后一拍:这件做完、待验收,并在群里汇报 */
export const LIVE_FINISH = {
  phase: '已完成', reportMsg: 'r-login', elapsed: '7 分钟', cost: '¥0.61', result: '深色主题、7 天免登，测试全部通过',
  evidence: [{ text: '4 项测试通过', ref: 'x' }, { text: 'Astra 复核通过', ref: 'y' }],
  act: { id: 'fin', step: 4, kind: 'report', title: '在群里汇报并 @你', at: '刚刚' } as Activity,
  checkpoint: { id: 'cp2', label: '测试通过、复核通过', step: 3, at: '02:19', files: 3 },
  checkOut: '通过 (1.2s)',
}
