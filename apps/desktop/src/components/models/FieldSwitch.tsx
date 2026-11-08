import type { ComponentProps } from 'react'
import { useField } from '@/components/ui/field'
import { Switch } from '@/components/ui/switch'

/** 放在 Field 里的开关:拿 Field 的 id 和说明,点标签也能切换 */
export function FieldSwitch(props: ComponentProps<typeof Switch>) {
  const f = useField()
  return <Switch id={f?.id} aria-describedby={f?.describedBy} {...props} />
}
