import { useSyncExternalStore } from 'react'
import { LAYOUT } from '@/config/layout'
import { useApp } from '@/store'

const query = `(min-width: ${LAYOUT.fileContextMinWidth}px)`
const subscribe = (onChange: () => void) => {
  const media = window.matchMedia(query)
  media.addEventListener('change', onChange)
  return () => media.removeEventListener('change', onChange)
}
const getSnapshot = () => window.matchMedia(query).matches

export function useFileContextPanel() {
  const wide = useSyncExternalStore(subscribe, getSnapshot, () => false)
  const { preference, setOpen } = useApp((s) => ({ preference: s.fileContextPreference, setOpen: s.setFileContextPreference }))
  return { open: preference ?? wide, setOpen }
}
