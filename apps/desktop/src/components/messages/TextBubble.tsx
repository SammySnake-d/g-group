import { useState } from 'react'
import { cn } from '@/lib/utils'
import { useApp } from '@/ctx'
import { broken, candidate } from '@/mut'
import { Pressable } from './Pressable'
import { renderText } from './mentions'
import { SHOT_PLACEHOLDER } from './copy'
import type { TextMsg } from './types'

/** 文字气泡:你的是墨色实底,别人的是白纸细边;超过 4 行 / 160 字先收成 3 行 */
export function TextBubble({ m }: { m: TextMsg }) {
  const { computes, openSplit } = useApp()
  const mine = m.from === 'me'
  const long = m.text.length > 160 || m.text.split('\n').length > 4
  const [open, setOpen] = useState(false)
  /* AC-40⑦ / U88:联系人同时做几件事时,汇报开头带这件事的短名;点了看那件事 */
  const tk = m.task && candidate('U88') && !broken('AC-40-7') ? computes[m.task] : undefined
  return (
    <div className={cn('break-words rounded-[18px] px-3.5 py-[7px] text-[14.5px] leading-[1.6]', mine ? 'bg-mine text-mine-fg' : 'border border-theirs-line bg-theirs text-fg shadow-soft')}>
      {tk?.short && (
        <Pressable data-testid={`short-${m.id}`} onClick={(e) => { e.stopPropagation(); openSplit({ t: 'compute', id: tk.id }) }}
          className="mr-1.5 h-5 -translate-y-px rounded-md bg-hover px-1.5 align-middle text-[12px] font-medium text-fg-2 hover:text-fg">{tk.short}</Pressable>
      )}
      <span className={cn('whitespace-pre-wrap', long && !open && 'line-clamp-3')}>{renderText(m.text.replace(tk?.short ? new RegExp('^' + tk.short + '[：:]\\s*') : /^$/, ''), mine, m.id)}</span>
      {m.edited && <span data-testid={`edited-${m.id}`} className={cn('ml-1.5 text-[11.5px]', mine ? 'text-me-fg/70' : 'text-fg-3')}>已编辑</span>}
      {m.byHelper && <span className="mt-0.5 block text-[11px] text-me-fg/75">由 Helper 代你发出</span>}
      {m.shot && (
        <Pressable data-testid={`shot-${m.id}`} onClick={(e) => { e.stopPropagation(); openSplit({ t: 'compute', id: m.shot!.compute, view: 'preview' }) }}
          className="mt-1.5 flex w-[220px] flex-col items-stretch overflow-hidden rounded-lg border border-line bg-bg">
          <span className="flex h-[86px] items-center justify-center bg-hover text-[12px] text-fg-3">{SHOT_PLACEHOLDER}</span>
          <span className="truncate px-2 py-1 text-[11.5px] text-fg-2">{m.shot.title}</span>
        </Pressable>
      )}
      {long && (
        <Pressable data-testid={`expand-${m.id}`} onClick={(e) => { e.stopPropagation(); setOpen((o) => !o) }}
          className={cn('mt-0.5 flex text-[12.5px] font-medium hover:underline', mine ? 'text-me-fg/80' : 'text-me')}>{open ? '收起' : '展开全文'}</Pressable>
      )}
    </div>
  )
}
