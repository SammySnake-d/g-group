import * as Collapsible from '@animate-ui/react/primitives/radix-ui/collapsible'
import type { ReactNode } from 'react'

/* 受控的展开/收起:Animate UI 的 Collapsible(高度、淡入、收起更快都由库按 token 做,尊重 reduced-motion)。
   触发按钮在外面自己管 open 状态(行本身就是按钮,不能再套一层 Trigger),这里只放内容。 */
export function Collapse({ open, children, className, testid }: { open: boolean; children: ReactNode; className?: string; testid?: string }) {
  return (
    <Collapsible.Root open={open}>
      <Collapsible.Content data-testid={testid} className={className}>
        {children}
      </Collapsible.Content>
    </Collapsible.Root>
  )
}
