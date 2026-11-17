// DS-Bot's complete desktop-window entry, not a g-group reconstruction of it.
// These sheets are inserted by the upstream Electron host; load the same sheets
// here because g-group retains its own secure Electron host and IPC boundary.
import './dsbot-base/upstream/app/src/fonts.css'
import './dsbot-base/upstream/app/src/material.css'
import './dsbot-base/upstream/app/src/page-card.css'
import macCss from './dsbot-base/upstream/app/src/macos.css?raw'
import './dsbot-base/upstream/app/ui/src/main.js'

const runtimeNavigator = navigator as Navigator & { userAgentData?: { platform?: string } }
if (/mac/iu.test(runtimeNavigator.userAgentData?.platform ?? navigator.platform)) {
  const style = document.createElement('style')
  style.dataset.dsBotHost = 'macos'
  style.textContent = macCss
  document.head.append(style)
}
