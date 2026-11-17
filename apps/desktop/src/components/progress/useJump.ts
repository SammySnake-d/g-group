import { useCallback } from 'react'
import { useApp } from '@/ctx'

/*
  单击即跳(#806「遮罩的目的就是为了跳转的」):点哪一项就关掉看板、落到它的真实入口。落点照 g-group-progress-panel 原型 README:
  - 群聊 / 私聊 → 那个聊天;群级提示 → 那个群
  - 群里的联系人 → 那个群 + 右边它在本群的完整过程
  - 按联系人时点联系人 → 和它的私聊 + 右边它在所有群和私聊里的完整过程
  - Compute / 子任务 → 它所在的聊天 + 右边这条 Compute 的过程;等你处理的同时把聊天定位到它问你的那条消息
  只用 ctx 里已有的动作(openConv / openDm / openContact / openSplit / jump),不新增接线。
*/

export type Target =
  | { kind: 'conv'; conv: string }
  | { kind: 'contact'; conv: string; person: string }
  | { kind: 'person'; person: string }
  | { kind: 'compute'; conv: string; person: string; compute: string; askMsg?: string | undefined }

export function useJump() {
  const { computes, openConv, openDm, openContact, openSplit, jump, setPanoOpen } = useApp()
  return useCallback((t: Target) => {
    switch (t.kind) {
      case 'conv':
        openConv(t.conv)
        break
      case 'contact':
        openConv(t.conv)
        openContact(t.person, t.conv, 'process')
        break
      case 'person':
        setPanoOpen(false)
        openDm(t.person)
        openContact(t.person, undefined, 'process')
        break
      case 'compute':
        openConv(t.conv)
        // 演示补充的 Compute 没有详情页,落到联系人在本群的完整过程
        if (computes[t.compute]) openSplit({ t: 'compute', id: t.compute, view: 'activity' })
        else openContact(t.person, t.conv, 'process')
        if (t.askMsg) jump(t.askMsg)
        break
    }
  }, [computes, openConv, openDm, openContact, openSplit, jump, setPanoOpen])
}
