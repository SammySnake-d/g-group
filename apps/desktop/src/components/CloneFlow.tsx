import { useState, type ReactNode } from 'react'
import { X, Check, ChevronDown, ChevronRight, ChevronLeft, Minus } from 'lucide-react'
import { cn } from '@/lib/utils'
import { people, presetOf, dutyDefault, type PersonId } from '@/data'
import { useApp } from '@/ctx'
import { Avatar } from './Avatar'
import { Checkbox } from '@/components/ui/checkbox'

/* 群模板：复制团队到新项目，三步（概念卡第 12 张；#1160 #1172 #1278） */

type GroupKey = 'member' | 'rule' | 'flow' | 'lesson' | 'local'
type Item = { id: string; group: GroupKey; text: string; src: string; who?: PersonId }

const GROUPS: { key: GroupKey; title: string; desc: string }[] = [
  { key: 'member', title: '成员', desc: '每位助手写给自己看的工作方式和会的技能，跟着它本人走' },
  { key: 'rule', title: '群规', desc: '群公告里的规矩，每句一条' },
  { key: 'flow', title: '配合方式', desc: '这个团队怎么分工、怎么交接' },
  { key: 'lesson', title: '经验', desc: '被纠正过、到哪都该记住的事' },
  { key: 'local', title: '只在这个项目用（默认不带）', desc: '这些事实只对原来的项目成立，换了项目多半不对' },
]
const STEPS = ['起名并选成员', '检查要带走的规则和经验', '确认']

export function CloneFlow({ id }: { id: string }) {
  const { convs, playbook, createGroup, closeAll } = useApp()
  const g = convs.find((c) => c.id === id)
  const [step, setStep] = useState(0)
  const [title, setTitle] = useState(() => `${g?.title ?? '群'}（新项目）`)
  const allMembers = (g?.members ?? []).filter((m) => m !== 'me')
  const [members, setMembers] = useState<PersonId[]>(allMembers)

  const ruleItems: Item[] = (g?.notice ?? '').split(/[\n。；]/).map((s) => s.trim()).filter(Boolean).map((s, i) => ({ id: `rule-${i}`, group: 'rule', text: s, src: g?.noticeBy ? `群公告 · ${g.noticeBy}` : '群公告' }))
  const pbItems: Item[] = playbook.map((p) => ({
    id: p.id,
    group: p.scope === 'project' ? 'local' : p.kind === '分工' || p.kind === '交接' ? 'flow' : 'lesson',
    text: p.text,
    src: `来自 ${p.src}`,
  }))
  const memberItems: Item[] = members.filter((m) => !people[m]?.human).map((m) => {
    const tools = (people[m].tools ?? []).filter((t) => t.on).map((t) => t.name)
    return { id: `mem-${m}`, group: 'member', who: m, text: `${presetOf[m] ?? people[m].role}${tools.length ? `　技能：${tools.join('、')}` : ''}`, src: `${people[m].name} 的设定` }
  })
  const items = [...memberItems, ...ruleItems, ...pbItems]

  const [off, setOff] = useState<Record<string, boolean>>({})
  const [localOn, setLocalOn] = useState<Record<string, boolean>>({})
  const [openLocal, setOpenLocal] = useState(false)
  const picked = (it: Item) => (it.group === 'local' ? !!localOn[it.id] : !off[it.id])
  const toggle = (it: Item, v: boolean) => (it.group === 'local' ? setLocalOn((s) => ({ ...s, [it.id]: v })) : setOff((s) => ({ ...s, [it.id]: !v })))

  if (!g) return <div className="p-6 text-[14px] text-fg-3">找不到这个群</div>

  const kept = items.filter(picked)
  const dropped = items.filter((it) => !picked(it))
  const nRules = kept.filter((it) => it.group !== 'member').length
  const nMembers = members.length
  const canNext = step === 0 ? title.trim() && members.length > 0 : true

  const go = () => {
    createGroup(title.trim(), members, `从「${g.title}」复制了团队：带了 ${nMembers} 位成员、${nRules} 条规则和经验；没有带聊天记录、文件和任务`)
    closeAll()
  }

  return (
    <div data-testid="clone-flow" className="flex h-full min-h-0 flex-col">
      <ol className="flex items-center gap-1.5 border-b border-line px-4 py-3">
        {STEPS.map((s, i) => (
          <li key={s} className="flex min-w-0 items-center gap-1.5">
            <span className={cn('grid h-5 w-5 shrink-0 place-items-center rounded-full text-[11px] font-semibold', i < step ? 'bg-fg-3 text-bg' : i === step ? 'bg-me text-me-fg' : 'border border-line text-fg-3')}>{i < step ? <Check className="h-3 w-3" /> : i + 1}</span>
            <span className={cn('truncate text-[12.5px]', i === step ? 'font-medium text-fg' : 'text-fg-3')}>{s}</span>
            {i < STEPS.length - 1 && <ChevronRight className="h-3.5 w-3.5 shrink-0 text-fg-3" />}
          </li>
        ))}
      </ol>

      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {step === 0 && (
          <section data-testid="clone-step-1">
            <label className="text-[12.5px] font-medium text-fg-2">新群名</label>
            <input data-testid="clone-title" value={title} onChange={(e) => setTitle(e.target.value)} className="mt-1.5 h-10 w-full rounded-lg border border-line bg-bg px-3 text-[14px] outline-none focus:border-fg-3" />
            <div className="mt-5 flex items-baseline justify-between">
              <span className="text-[12.5px] font-medium text-fg-2">拉谁进新群（{members.length}/{allMembers.length}）</span>
              {members.length < allMembers.length && <button onClick={() => setMembers(allMembers)} className="text-[12px] text-fg-3 hover:text-fg">全部加回来</button>}
            </div>
            <p className="mt-1 text-[12px] text-fg-3">同一个助手进新群还是同一个“人”，它的记忆跟着它自己走。</p>
            <div className="mt-2.5 grid grid-cols-2 gap-2">
              {allMembers.map((m) => {
                const on = members.includes(m)
                return (
                  <div key={m} data-testid={`clone-member-${m}`} className={cn('relative flex items-center gap-2.5 rounded-xl border px-3 py-2.5', on ? 'border-line bg-bg' : 'border-dashed border-line opacity-50')}>
                    <Avatar id={m} size={32} status={false} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13.5px] font-medium">{people[m].name}</div>
                      <div className="truncate text-[12px] text-fg-3">{dutyDefault[m] ?? people[m].role}</div>
                    </div>
                    {on ? (
                      <button aria-label={`不带 ${people[m].name}`} data-testid={`clone-member-remove-${m}`} onClick={() => setMembers((l) => l.filter((x) => x !== m))} className="grid h-6 w-6 place-items-center rounded-full text-fg-3 hover:bg-hover hover:text-fg"><X className="h-3.5 w-3.5" /></button>
                    ) : (
                      <button onClick={() => setMembers((l) => allMembers.filter((x) => l.includes(x) || x === m))} className="text-[12px] text-fg-2 hover:text-fg">加回</button>
                    )}
                  </div>
                )
              })}
            </div>
          </section>
        )}

        {step === 1 && (
          <section data-testid="clone-step-2" className="space-y-3">
            <p className="text-[12.5px] text-fg-3">默认都带上。不想带的取消勾选，每条后面写着它从哪来。</p>
            {GROUPS.map((gr) => {
              const list = items.filter((it) => it.group === gr.key)
              if (!list.length) return null
              const local = gr.key === 'local'
              const open = !local || openLocal
              const n = list.filter(picked).length
              return (
                <div key={gr.key} className={cn('overflow-hidden rounded-xl border border-line', local ? 'bg-hover/40' : 'bg-bg')}>
                  <button disabled={!local} data-testid={local ? 'clone-local-toggle' : undefined} onClick={() => setOpenLocal((v) => !v)} className="flex w-full items-center gap-2 px-3.5 py-2.5 text-left">
                    {local && (open ? <ChevronDown className="h-4 w-4 text-fg-3" /> : <ChevronRight className="h-4 w-4 text-fg-3" />)}
                    <span className="flex-1">
                      <span className="text-[13.5px] font-medium">{gr.title}</span>
                      <span className="block text-[12px] text-fg-3">{gr.desc}</span>
                    </span>
                    <span className="text-[12px] text-fg-3">带 {n}/{list.length}</span>
                  </button>
                  {open && (
                    <div className="border-t border-line [&>*+*]:border-t [&>*+*]:border-line">
                      {list.map((it) => (
                        <label key={it.id} data-testid={`clone-item-${it.id}`} className="flex cursor-pointer items-start gap-2.5 px-3.5 py-2.5 hover:bg-hover/60">
                          <Checkbox checked={picked(it)} onCheckedChange={(v) => toggle(it, !!v)} className="mt-0.5 rounded-[5px]" />
                          {it.who && <Avatar id={it.who} size={20} status={false} />}
                          <span className={cn('min-w-0 flex-1 text-[13.5px] leading-snug', !picked(it) && 'text-fg-3 line-through decoration-fg-3/50')}>
                            {it.who && <span className="font-medium">{people[it.who].name}：</span>}{it.text}
                            <span className="ml-1.5 whitespace-nowrap text-[11.5px] text-fg-3">{it.src}</span>
                          </span>
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
          </section>
        )}

        {step === 2 && (
          <section data-testid="clone-step-3">
            <div className="mb-3 rounded-xl border border-line bg-bg px-3.5 py-2.5 text-[13.5px]">新群「<span className="font-medium">{title.trim()}</span>」：{nMembers} 位成员，{nRules} 条规则和经验</div>
            <div className="grid grid-cols-2 gap-3">
              <Column title="会带过去" icon={<Check className="h-3.5 w-3.5 text-ok" />} testid="clone-keep">
                <Sub title={`成员 ${nMembers} 位`} lines={members.map((m) => people[m].name)} />
                {GROUPS.filter((gr) => gr.key !== 'member').map((gr) => {
                  const l = kept.filter((it) => it.group === gr.key)
                  return l.length ? <Sub key={gr.key} title={`${gr.key === 'local' ? '只在原项目用、你选了带的' : gr.title} ${l.length} 条`} lines={l.map((it) => it.text)} /> : null
                })}
              </Column>
              <Column title="不会带过去" icon={<Minus className="h-3.5 w-3.5 text-fg-3" />} testid="clone-drop" muted>
                <Sub title="项目内容" lines={['全部聊天消息', '文件和资产（含服务器账号）', '在做和做完的任务与清单']} />
                {dropped.some((it) => it.group === 'local') && <Sub title="只对这个项目成立的事实" lines={dropped.filter((it) => it.group === 'local').map((it) => it.text)} />}
                {dropped.some((it) => it.group !== 'local') && <Sub title="你取消勾选的" lines={dropped.filter((it) => it.group !== 'local').map((it) => (it.who ? `${people[it.who].name} 的设定` : it.text))} />}
                {allMembers.length > members.length && <Sub title="你去掉的成员" lines={allMembers.filter((m) => !members.includes(m)).map((m) => people[m].name)} />}
              </Column>
            </div>
          </section>
        )}
      </div>

      <div className="flex items-center gap-2 border-t border-line p-3">
        {step > 0 && <button data-testid="clone-prev" onClick={() => setStep((s) => s - 1)} className="flex h-10 items-center gap-1 rounded-xl border border-line px-4 text-[14px] hover:bg-hover"><ChevronLeft className="h-4 w-4" />上一步</button>}
        <span className="flex-1" />
        {step < 2 ? (
          <button data-testid="clone-next" disabled={!canNext} onClick={() => setStep((s) => s + 1)} className={cn('h-10 rounded-xl px-5 text-[14px] font-medium', canNext ? 'bg-me text-me-fg' : 'bg-hover text-fg-3')}>下一步</button>
        ) : (
          <button data-testid="clone-go" onClick={go} className="h-10 rounded-xl bg-me px-5 text-[14px] font-medium text-me-fg">创建新群</button>
        )}
      </div>
    </div>
  )
}

function Column({ title, icon, children, testid, muted }: { title: string; icon: ReactNode; children: ReactNode; testid: string; muted?: boolean }) {
  return (
    <div data-testid={testid} className={cn('rounded-xl border border-line px-3 py-2.5', muted ? 'bg-hover/40' : 'bg-bg')}>
      <div className="mb-2 flex items-center gap-1.5 text-[13px] font-medium">{icon}{title}</div>
      <div className="space-y-2.5">{children}</div>
    </div>
  )
}

function Sub({ title, lines }: { title: string; lines: string[] }) {
  return (
    <div>
      <div className="text-[12px] font-medium text-fg-2">{title}</div>
      <ul className="mt-0.5 space-y-0.5">
        {lines.map((l, i) => <li key={i} className="line-clamp-2 text-[12.5px] leading-snug text-fg-3">· {l}</li>)}
      </ul>
    </div>
  )
}
