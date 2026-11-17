import { Check, ChevronDown, ChevronRight, Minus, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { people, dutyDefault, type PersonId } from '@/data'
import { Collapse } from '@/components/pages/kit/collapse'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/icon-button'
import { Checkbox } from '@/components/ui/checkbox'
import { Field, Hint, TextInput } from '@/components/pages/kit/parts'
import { Avatar } from '../../Avatar'
import { CLONE_LIVE, GROUPS, GROUPS_LIVE, NEVER_CARRIED, type Item } from './constants'
import { Column, Sub } from './CloneSummary'

/* 复制团队的三步视图:只管展示和把操作交回 CloneFlow,状态都在 CloneFlow 里。
   live(连着后端):第 2 步只有「成员的预设(只读)」「群公告」两组,写明协作手册以后再定;只读的条目不带勾选框。 */

export function StepName({ title, setTitle, allMembers, members, setMembers }: { title: string; setTitle: (v: string) => void; allMembers: PersonId[]; members: PersonId[]; setMembers: (f: (l: PersonId[]) => PersonId[]) => void }) {
  return (
    <section data-testid="clone-step-1">
      <Field label="新群名">
        <TextInput data-testid="clone-title" value={title} onChange={(e) => setTitle(e.target.value)} className="mt-0.5" />
      </Field>
      <div className="mt-5 flex items-center justify-between gap-2">
        <span className="text-[12.5px] font-medium text-fg-2">拉谁进新群（<span className="tabular-nums">{members.length}/{allMembers.length}</span>）</span>
        {members.length < allMembers.length && <Button variant="ghost" size="xs" onClick={() => setMembers(() => allMembers)} className="-mr-2 font-normal text-fg-3">全部加回来</Button>}
      </div>
      <Hint className="mt-1 text-[12px]">同一个助手进新群还是同一个“人”，它的记忆跟着它自己走。</Hint>
      <div className="mt-2.5 grid grid-cols-2 gap-2">
        {allMembers.map((m) => {
          const on = members.includes(m)
          return (
            <div key={m} data-testid={`clone-member-${m}`} className={cn('relative flex min-w-0 items-center gap-2.5 rounded-xl border px-3 py-2.5 transition-opacity duration-fast ease-out', on ? 'border-line bg-bg' : 'border-dashed border-line opacity-50')}>
              <Avatar id={m} size={32} status={false} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13.5px] font-medium">{people[m].name}</div>
                <div className="truncate text-[12px] text-fg-3">{dutyDefault[m] ?? people[m].role}</div>
              </div>
              {on ? (
                <IconButton data-testid={`clone-member-remove-${m}`} label={`不带 ${people[m].name}`} size="icon-xs" icon={<X />} onClick={() => setMembers((l) => l.filter((x) => x !== m))} className="rounded-full text-fg-3" />
              ) : (
                <Button variant="ghost" size="xs" onClick={() => setMembers((l) => allMembers.filter((x) => l.includes(x) || x === m))} className="-mr-1 px-2 font-normal">加回</Button>
              )}
            </div>
          )
        })}
      </div>
    </section>
  )
}

export function StepPick({ items, picked, toggle, openLocal, setOpenLocal, live }: { items: Item[]; picked: (it: Item) => boolean; toggle: (it: Item, v: boolean) => void; openLocal: boolean; setOpenLocal: (f: (v: boolean) => boolean) => void; live?: boolean }) {
  return (
    <section data-testid="clone-step-2" className="space-y-3">
      <Hint>{live ? CLONE_LIVE.pickHint : '默认都带上。不想带的取消勾选，每条后面写着它从哪来。'}</Hint>
      {live && <Hint testid="clone-playbook-later" className="rounded-xl bg-hover px-3.5 py-2.5 text-fg-2">{CLONE_LIVE.playbookLater}</Hint>}
      {live && !items.some((it) => it.group === 'rule') && <Hint testid="clone-no-notices">{CLONE_LIVE.noNotices}</Hint>}
      {(live ? GROUPS_LIVE : GROUPS).map((gr) => {
        const list = items.filter((it) => it.group === gr.key)
        if (!list.length) return null
        const local = gr.key === 'local'
        const open = !local || openLocal
        const readonly = list.every((it) => it.readonly)
        const n = list.filter(picked).length
        const head = (
          <>
            {local && (open ? <ChevronDown className="h-4 w-4 shrink-0 text-fg-3" /> : <ChevronRight className="h-4 w-4 shrink-0 text-fg-3" />)}
            <span className="min-w-0 flex-1">
              <span className="text-[13.5px] font-medium text-fg">{gr.title}</span>
              <span className="block text-[12px] font-normal text-fg-3">{gr.desc}</span>
            </span>
            {!readonly && <span className="shrink-0 text-[12px] font-normal tabular-nums text-fg-3">带 {n}/{list.length}</span>}
          </>
        )
        const rows = (
          <div className="border-t border-line [&>*+*]:border-t [&>*+*]:border-line">
            {list.map((it) => it.readonly ? (
              <div key={it.id} data-testid={`clone-item-${it.id}`} className="flex items-start gap-2.5 px-3.5 py-2.5">
                {it.who && <Avatar id={it.who} size={20} status={false} />}
                <span className="min-w-0 flex-1 text-[13.5px] leading-snug">
                  <span className="flex min-w-0 items-baseline gap-1.5">{it.who && <span className="truncate font-medium">{people[it.who].name}</span>}<span className="shrink-0 text-[11.5px] text-fg-3">{it.src}</span></span>
                  <span className="mt-0.5 line-clamp-4 whitespace-pre-line text-[13px] text-fg-2">{it.text}</span>
                </span>
              </div>
            ) : (
              <label key={it.id} data-testid={`clone-item-${it.id}`} className="flex cursor-pointer items-start gap-2.5 px-3.5 py-2.5 transition-colors duration-fast ease-out hover:bg-hover/60">
                <Checkbox checked={picked(it)} onCheckedChange={(v) => toggle(it, !!v)} className="mt-0.5 rounded-[5px]" />
                {it.who && <Avatar id={it.who} size={20} status={false} />}
                <span className={cn('min-w-0 flex-1 text-[13.5px] leading-snug', !picked(it) && 'text-fg-3 line-through decoration-fg-3/50')}>
                  {it.who && <span className="font-medium">{people[it.who].name}：</span>}{it.text}
                  <span className="ml-1.5 whitespace-nowrap text-[11.5px] text-fg-3">{it.src}</span>
                </span>
              </label>
            ))}
          </div>
        )
        return (
          <div key={gr.key} className={cn('overflow-hidden rounded-xl border border-line', local ? 'bg-hover/40' : 'bg-bg')}>
            {local ? (
              <Button variant="ghost" data-testid="clone-local-toggle" aria-expanded={open} onClick={() => setOpenLocal((v) => !v)}
                className="h-auto w-full justify-start gap-2 whitespace-normal rounded-none px-3.5 py-2.5 text-left active:scale-100">{head}</Button>
            ) : (
              <div className="flex w-full items-center gap-2 px-3.5 py-2.5">{head}</div>
            )}
            {local ? <Collapse open={open}>{rows}</Collapse> : rows}
          </div>
        )
      })}
    </section>
  )
}

export function StepConfirm({ title, members, allMembers, kept, dropped, nMembers, nRules, live }: { title: string; members: PersonId[]; allMembers: PersonId[]; kept: Item[]; dropped: Item[]; nMembers: number; nRules: number; live?: boolean }) {
  return (
    <section data-testid="clone-step-3">
      <div className="mb-3 rounded-xl border border-line bg-bg px-3.5 py-2.5 text-[13.5px]">新群「<span className="font-medium">{title.trim()}</span>」：<span className="tabular-nums">{nMembers}</span> 位成员，<span className="tabular-nums">{nRules}</span> {live ? '条群公告' : '条规则和经验'}</div>
      <div className="grid grid-cols-2 gap-3">
        <Column title="会带过去" icon={<Check className="h-3.5 w-3.5 text-ok" />} testid="clone-keep">
          <Sub title={`成员 ${nMembers} 位`} lines={members.map((m) => people[m].name)} />
          {(live ? GROUPS_LIVE : GROUPS).filter((gr) => gr.key !== 'member').map((gr) => {
            const l = kept.filter((it) => it.group === gr.key)
            return l.length ? <Sub key={gr.key} title={`${gr.key === 'local' ? '只在原项目用、你选了带的' : gr.title} ${l.length} 条`} lines={l.map((it) => it.text)} /> : null
          })}
        </Column>
        <Column title="不会带过去" icon={<Minus className="h-3.5 w-3.5 text-fg-3" />} testid="clone-drop" muted>
          <Sub title="项目内容" lines={NEVER_CARRIED} />
          {live && <Sub title={CLONE_LIVE.laterTitle} lines={[...CLONE_LIVE.laterLines]} />}
          {dropped.some((it) => it.group === 'local') && <Sub title="只对这个项目成立的事实" lines={dropped.filter((it) => it.group === 'local').map((it) => it.text)} />}
          {dropped.some((it) => it.group !== 'local') && <Sub title="你取消勾选的" lines={dropped.filter((it) => it.group !== 'local').map((it) => (it.who ? `${people[it.who].name} 的设定` : it.text))} />}
          {allMembers.length > members.length && <Sub title="你去掉的成员" lines={allMembers.filter((m) => !members.includes(m)).map((m) => people[m].name)} />}
        </Column>
      </div>
    </section>
  )
}
