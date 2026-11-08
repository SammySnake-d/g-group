/* 提问卡片里的一个选项,照 mirasim 的提问选项搬:没有边框的浅底块,悬停换选中底;
   短选项排成一行(chip),长选项每项占一整行(row,文字可换行)。
   状态:可选 / 推荐(靛蓝浅底 + 「推荐」标)/ 你选的这项(靛蓝浅底 + 对勾)/ 答完后其余项(弱化、不能再点)/ 过期(划掉) */
import { Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Chip } from '@/components/ui/chip'
import { Pressable } from '../Pressable'
import type { AskOpt } from './askModel'

type Props = { o: AskOpt; testid: string; picked: boolean; can: boolean; stale: boolean }

/** 两种排法共用的底色与状态;Button 原语默认的 disabled 半透明不用(会把你选的那项也弄淡) */
function tone({ o, picked, can, stale }: Omit<Props, 'testid'>) {
  return cn('min-h-7 gap-1.5 rounded-md px-2.5 text-[13px] font-medium disabled:opacity-100 disabled:cursor-default',
    picked ? 'bg-me/10 text-fg'
      : can ? (o.primary ? 'bg-me/[.07] text-fg hover:bg-me/[.12]' : 'bg-hover text-fg-2 hover:bg-sel hover:text-fg')
      : 'bg-hover text-fg-3',
    stale && 'line-through')
}

export function AskChipOption({ o, testid, ...st }: Props) {
  return (
    <Pressable data-testid={testid} disabled={!st.can} onClick={o.run} className={tone({ o, ...st })}>
      {st.picked && <Check className="h-3.5 w-3.5 text-me" strokeWidth={2.5} />}{o.label}
    </Pressable>
  )
}

export function AskRowOption({ o, testid, ...st }: Props) {
  return (
    <Pressable data-testid={testid} disabled={!st.can} onClick={o.run}
      className={cn(tone({ o, ...st }), 'flex w-full items-start whitespace-normal py-1.5 leading-[1.5]')}>
      {st.picked && <Check className="mt-[3px] h-3.5 w-3.5 text-me" strokeWidth={2.5} />}
      <span className="min-w-0 flex-1 break-words">{o.label}</span>
      {o.primary && st.can && <Chip tone="link" size="xs" className="mt-px">推荐</Chip>}
    </Pressable>
  )
}
