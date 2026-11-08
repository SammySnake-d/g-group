import * as ToggleGroup from '@animate-ui/react/primitives/radix-ui/toggle-group'
import type { ModelSlot } from '@g-group/ui-core'
import { MODE_LABEL } from '@/modelConfig'
import { CM, MODES } from './constants'

type Mode = ModelSlot['mode']

/** Compute 模型从哪来:继承全局 / 跟随说话模型 / 单独指定,竖排单选。选中底色由 Animate UI 的高亮层滑过去 */
export function ComputeModeList({ value, hints, onPick }: { value: Mode; hints: Record<Mode, string>; onPick: (m: Mode) => void }) {
  return (
    <ToggleGroup.Root type="single" orientation="vertical" value={value} aria-label={CM.modeGroup} onValueChange={(v) => { if (v) onPick(v as Mode) }}
      className="flex flex-col overflow-hidden rounded-lg bg-bg ring-1 ring-line [&>*+*]:border-t [&>*+*]:border-line">
      {MODES.map((m) => (
        <ToggleGroup.Item key={m} value={m} data-testid={`cm-mode-${m}`}
          className="group flex w-full items-center gap-2.5 px-3 py-2 text-left outline-none transition-[background-color] duration-fast ease-out hover:bg-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/60 data-[state=on]:bg-sel/70">
          <span aria-hidden className="grid h-4 w-4 shrink-0 place-items-center rounded-full border border-fg-3 group-data-[state=on]:border-fg">
            <span className="h-2 w-2 scale-0 rounded-full bg-fg group-data-[state=on]:scale-100" />
          </span>
          <span className="w-[88px] shrink-0 text-[13px] text-fg group-data-[state=on]:font-semibold">{MODE_LABEL[m]}</span>
          <span className="min-w-0 truncate text-[12px] text-fg-3">{hints[m]}</span>
        </ToggleGroup.Item>
      ))}
    </ToggleGroup.Root>
  )
}
