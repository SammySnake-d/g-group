import { appShell, needsSetup, startAppShell, useAppShell } from '@/api/app-shell'
import { SetupScreen } from '@/components/shell/SetupScreen'
import { DsBotApp } from '@/dsbot-base/DsBotApp'
import { useEffect } from 'react'

/*
 * The renderer entry is deliberately the DS-Bot shaped frame.  g-group's
 * backend remains behind the existing window.gg contract; the old g-group
 * workbench is not used to assemble the primary conversation surface anymore.
 */
export default function App() {
  useEffect(() => startAppShell(), [])
  const setup = useAppShell((s) => s.setup)
  if (appShell && !setup) return <div className="h-full bg-bg" />
  if (needsSetup(setup)) return <SetupScreen />
  return <DsBotApp />
}
