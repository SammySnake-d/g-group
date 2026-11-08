import { Trash2 } from 'lucide-react'
import { people, dutyByConv, dutyDefault, type Conversation } from '@/data'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/icon-button'
import { Checkbox } from '@/components/ui/checkbox'
import { TextInput } from '@/components/pages/kit/parts'
import { Avatar } from '../Avatar'
import { CardLabel, ConfirmCard } from './parts'
import type { CsvCard, GroupCard } from './types'

/* 面板里的两张确认卡:Helper 先把要做的事摆出来,你改好、点了才执行 */

export function GroupConfirm({ c, card, onChange, onCreate }: { c: Conversation; card: GroupCard; onChange: (g: GroupCard) => void; onCreate: () => void }) {
  const by = dutyByConv[c.id] ?? {}
  const ids = Object.keys(card.picks)
  const n = card.bg.filter((b) => b.on).length
  const ok = ids.some((i) => card.picks[i]) && !!card.title.trim()
  const done = !!card.done
  return (
    <ConfirmCard title="另开一个群" done={card.done && `${card.done}，原群「${c.title}」里没有多任何消息`}>
      <label className="block">
        <span className="block text-[12px] text-fg-3">新群名</span>
        <TextInput dense value={card.title} disabled={done} onChange={(e) => onChange({ ...card, title: e.target.value })} className="mt-1 text-[13.5px]" />
      </label>
      <CardLabel>拉谁（按本群分工推荐）</CardLabel>
      <div className="mt-1 space-y-1.5">
        {ids.map((id) => (
          <label key={id} className="flex cursor-pointer items-start gap-2">
            <Checkbox checked={card.picks[id]} disabled={done} onCheckedChange={(v) => onChange({ ...card, picks: { ...card.picks, [id]: !!v } })} className="mt-1 rounded-[5px]" />
            <Avatar id={id} size={22} status={false} />
            <span className="min-w-0 flex-1 leading-snug">{people[id].name}<span className="block text-[12px] text-fg-3">推荐理由：本群里负责「{by[id] ?? dutyDefault[id]}」</span></span>
          </label>
        ))}
      </div>
      <CardLabel>带哪几条当背景（<span className="tabular-nums">{n}</span> 条）</CardLabel>
      <div className="mt-1 space-y-1.5">
        {card.bg.map((b) => (
          <label key={b.id} className="flex cursor-pointer items-start gap-2">
            <Checkbox checked={b.on} disabled={done} onCheckedChange={(v) => onChange({ ...card, bg: card.bg.map((x) => (x.id === b.id ? { ...x, on: !!v } : x)) })} className="mt-1 rounded-[5px]" />
            <span className="line-clamp-2 min-w-0 flex-1 text-[13px] text-fg-2">{b.text}</span>
          </label>
        ))}
      </div>
      {!done && <Button data-testid="hp-create-group" variant="primary" disabled={!ok} onClick={onCreate} className="mt-3 w-full">创建</Button>}
    </ConfirmCard>
  )
}

export function CsvConfirm({ card, onChange, onConfirm }: { card: CsvCard; onChange: (v: CsvCard) => void; onConfirm: () => void }) {
  return (
    <ConfirmCard title={<>功能清单.csv · <span className="tabular-nums">{card.rows.length}</span> 行</>} done={card.done && `已建成本群清单 ${card.rows.length} 项，并在群里 @所有人`}>
      <ol className="space-y-1.5">
        {card.rows.map((r, i) => (
          <li key={r.text} className="group flex items-start gap-2">
            <span className="w-4 shrink-0 pt-0.5 text-[12px] tabular-nums text-fg-3">{i + 1}</span>
            <span className="min-w-0 flex-1 leading-snug">{r.text}<span className="block text-[12px] text-fg-3">{r.who ? `推荐：${people[r.who].name}（${r.why}）` : '推荐：谁有空谁领'}</span></span>
            {!card.done && <IconButton label="删掉这行" tooltip={false} size="icon-xs" icon={<Trash2 />} onClick={() => onChange({ ...card, rows: card.rows.filter((_, j) => j !== i) })} className="text-fg-3 hover:text-err" />}
          </li>
        ))}
      </ol>
      {!card.done && <Button data-testid="hp-csv-confirm" variant="primary" disabled={!card.rows.length} onClick={onConfirm} className="mt-3 w-full">建成本群清单并 @所有人</Button>}
    </ConfirmCard>
  )
}
