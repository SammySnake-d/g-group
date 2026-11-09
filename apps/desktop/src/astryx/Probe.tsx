/* 开发用探针页(?preview=astryx):Astryx 基础控件挂在「纸·墨·柿」主题下,
   e2e 用它量主题是否真生效、Tailwind 类能否覆盖、键盘交互是否完整。不进产品界面。 */
import { useState } from 'react'
import { Button } from '@astryxdesign/core/Button'
import { Dialog } from '@astryxdesign/core/Dialog'
import { DropdownMenu } from '@astryxdesign/core/DropdownMenu'
import { Tooltip } from '@astryxdesign/core/Tooltip'
import { Switch } from '@astryxdesign/core/Switch'

export function AstryxProbe() {
  const [open, setOpen] = useState(false)
  const [on, setOn] = useState(false)
  const [picked, setPicked] = useState('')
  return (
    <div className="flex h-full flex-col gap-6 bg-bg p-8 text-fg" data-testid="astryx-probe">
      <section className="flex items-center gap-3">
        <Button label="主操作" variant="primary" data-testid="ax-primary" />
        <Button label="次要" variant="secondary" data-testid="ax-secondary" />
        <Button label="胶囊(Tailwind 改形)" variant="primary" className="rounded-full px-6" data-testid="ax-pill" />
        <Tooltip content="提示文字">
          <Button label="悬停看提示" variant="ghost" data-testid="ax-tip" />
        </Tooltip>
      </section>
      <section className="flex items-center gap-3">
        <DropdownMenu
          button={{ label: '更多', 'data-testid': 'ax-menu' } as never}
          items={[
            { label: '打开会话', onClick: () => setPicked('打开会话') },
            { label: '复制', onClick: () => setPicked('复制') },
            { label: '删除', variant: 'destructive', onClick: () => setPicked('删除') },
          ]}
        />
        <span data-testid="ax-picked">{picked}</span>
        <Switch label="定时启用" value={on} onChange={(v) => setOn(v)} data-testid="ax-switch" />
      </section>
      <section>
        <Button label="打开对话框" variant="secondary" onClick={() => setOpen(true)} data-testid="ax-open" />
        <Dialog isOpen={open} onOpenChange={setOpen} data-testid="ax-dialog">
          <div className="flex flex-col gap-3 p-5">
            <p>删除这个定时任务?</p>
            <div className="flex justify-end gap-2">
              <Button label="取消" variant="secondary" onClick={() => setOpen(false)} data-testid="ax-cancel" />
              <Button label="删除" variant="destructive" onClick={() => setOpen(false)} />
            </div>
          </div>
        </Dialog>
      </section>
    </div>
  )
}
