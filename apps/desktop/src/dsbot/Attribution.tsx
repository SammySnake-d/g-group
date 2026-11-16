import { DS_BOT_FRONTEND_SOURCE } from './theme'

/**
 * Small, user-facing attribution kept in About/diagnostics surfaces. It is
 * intentionally not placed in the chat flow: upstream attribution is a legal
 * and support concern, not a task the user needs to read while messaging.
 */
export function DsBotAttribution() {
  return (
    <p className="text-[11px] leading-5 text-fg-3">
      聊天界面使用 <a className="underline decoration-fg-3/50 underline-offset-2 hover:text-fg" href={DS_BOT_FRONTEND_SOURCE.repository} target="_blank" rel="noreferrer">DS-Bot</a> 前端组件（{DS_BOT_FRONTEND_SOURCE.commit.slice(0, 8)}，{DS_BOT_FRONTEND_SOURCE.license}），由 g-group 适配自己的后端与领域。
    </p>
  )
}
