import type { ComponentProps } from 'react'
import { useField } from '@/components/ui/field'
import { Switch } from '@/components/ui/switch'

export function FieldSwitch(props: ComponentProps<typeof Switch>) {
  const f = useField()
  return <Switch id={f?.id} aria-describedby={f?.describedBy} {...props} />
}
