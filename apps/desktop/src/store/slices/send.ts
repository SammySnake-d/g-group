// 发送切片:输入框回车后的整条路径——发出消息,再按内容分流(@Helper、记成定时、口头同意写盘、
// 回复汇报验收/返工、补进某件事、总结外部来源、改前提作废选项、被 @ 的助手接话)。
import { REACTION_EMOJI } from '@/config/emoji'
import { people, type Msg, type PersonId } from '@/data'
import { live, liveCtx } from '@/api/wire/live'
import { sendLive } from '@/api/wire/messages'
import { broken, candidate } from '@/mut'
import { frozen, later, uid } from '../boot'
import { lens, type Slice } from '../state'
import { activeConv, draftOf } from '../select'

type TextMsg = Extract<Msg, { k: 'text' }>
/** 回复汇报时表示「通过」的那个表情(和回应表情同一套配置) */
const THUMBS_UP = REACTION_EMOJI[0]
/** 坏实现 AC-46-3 拿来冒充已读的表情 */
const EYES = REACTION_EMOJI[3]
const PASS = new RegExp(`通过|没问题|可以|OK|ok|${THUMBS_UP}`)
const strip = (t: string) => t.replace(/@\S+\s*/g, '')

export type SendSlice = {
  /** override:斜杠命令(/handoff、助手命令)把要发的话直接递过来,走同一条发送路径(引用、@ 交代都照常) */
  send: (override?: string) => void
}

export const createSendSlice: Slice<SendSlice> = (set, get) => {
  const L = lens(set)
  return {
    send: (override) => {
      const s = get()
      const { active, computes, pending, editing, pushMsg, say, setDisp, addAct } = s
      const conv = activeConv(s)
      const q = s.quotes[active] ?? []
      const t = (override ?? draftOf(s, broken('AC-24'))).trim()
      if (editing) { s.editMsg(editing, t); return }
      if (!t && !q.length) return
      /* 连上后端:发给后端,回复、派活、进展都由后端的事件带回来;下面按正文分流的演示剧本一概不走 */
      if (live(s)) {
        s.setDraft('')
        L.quotes((all) => ({ ...all, [active]: [] }))
        void sendLive(liveCtx(get, set), conv?.id ?? active, t, q)
        return
      }
      const id = 'me-' + uid()
      const running = Object.values(computes).filter((c) => c.conv === active && c.status === 'running')
      const tag = conv.kind === 'dm' && running.length === 1 && !q.length ? { task: running[0].id, state: '已收到' } : undefined
      pushMsg({ k: 'text', id, from: 'me', text: t, quotes: q.length ? q : undefined, tag }, active)
      s.setDraft('')
      L.quotes((all) => ({ ...all, [active]: [] }))
      if (t.includes('@Helper')) { s.helperReply(active, t); return }

      /* #1858 路径 A:聊天里 @某个助手 + 「每天/工作日/每周一 + 几点」→ 真的记成它的定时,回一条确认,确认消息下挂灰字可点 */
      const tm = t.match(/(每天|工作日|每周一)[^0-9]{0,6}(\d{1,2})(?:[:：点](\d{1,2})?)?/)
      const tgt = Object.values(people).find((p) => t.includes('@' + p.name) && !p.human && p.id !== 'helper')
      if (tm && tgt) {
        let h = +tm[2]; if (/下午|晚上/.test(t) && h < 12) h += 12
        const time = `${String(h).padStart(2, '0')}:${String(+(tm[3] ?? 0)).padStart(2, '0')}`
        const what = strip(t).replace(tm[0], '').replace(/^[，,。\s]+/, '').replace(/^(钟|分)?[，,\s]*/, '').trim() || '按你说的做'
        const expr = `${+(tm[3] ?? 0)} ${h} * * ${tm[1] === '工作日' ? '1-5' : tm[1] === '每周一' ? '1' : '*'}`
        const cid = s.addCron({ owner: tgt.id as PersonId, conv: active, text: what, trigger: { kind: 'cron', expr }, speak: /才|有.*再/.test(what) ? 'only-if' : 'always', srcMsg: id }, 'chat')
        say(active, tgt.id as PersonId, `好，记成我的定时了：${tm[1]} ${time}，${what}。`, 900, { cron: cid, cronNew: true } as never)
        return
      }
      /* #2435 AC-17:在等你同意写盘时,你亲口说一句「同意/可以改/改吧」就放行,只放行这一次。
         只认你自己打字发出的这句;转发或引用里别人的「同意」不算(AC-20),这里只看你写的正文 t,不看引用 */
      const gate = pending.find((p) => p.kind === 'proposal' && p.gate && p.conv === active)
      if (gate && !broken('AC-17-said') && /^(同意|可以改|改吧|批准|行，?改吧|好，?改吧)/.test(strip(t).trim())) {
        s.resolve(gate.id, 'ok', 'said')
        return
      }
      /* #1754:验收不是按钮,是对汇报消息的一句回复。回复某个 Compute 的汇报且说了「通过/没问题/可以」,清单那一行就推进到已完成 */
      const rep = q.find((x) => x.reply)
      const done = rep && Object.values(computes).find((c) => c.reportMsg === rep.msgId)
      /* AC-28:回复汇报,说「再改 / 还要改 / 不行」就是退回返工:清单回到进行中,它回一句收到并标出要改什么;说「通过」才算完成 */
      if (done && !broken('AC-28') && /还要改|再改|不行|不对|返工|重做|改一下/.test(t)) {
        L.checklist((l) => l.map((x) => (x.attempts.includes(done.id) && x.status === '待验收' ? { ...x, status: '进行中' } : x)))
        L.computes((cs) => ({ ...cs, [done.id]: { ...cs[done.id], status: 'running', phase: '按你的意见返工', steps: cs[done.id].steps.map((st, i, arr) => (i === arr.length - 1 ? { ...st, state: 'now' } : st)) } }))
        say(active, done.owner, `收到，退回返工：${strip(t).slice(0, 30)}。改完再 @你。`, 900, { disp: undefined })
        later(() => setDisp(id, { by: done.owner, kind: 'doing', ref: done.id, refKind: 'compute', note: '退回返工' }), 1000)
        return
      }
      if (done && PASS.test(t)) {
        L.checklist((l) => l.map((x) => (x.attempts.includes(done.id) && x.status === '待验收' ? { ...x, status: '已完成' } : x)))
        later(() => setDisp(id, { by: done.owner, kind: 'done', ref: done.id, refKind: 'compute', note: '已验收' }), 1300)
      }
      /* AC-40⑨(当前必过,#1728 / U13 / US7;坏实现⑧前半):引用了某件事的消息(它的汇报、它的派活、它发的进度)再说一句 → 这句只补进那一件,
         不串到同一联系人手上的另一件。不依赖短名:引用的那条消息属于哪件事是确定的(task / reportMsg / askMsg)。
         候选 U88:没引用时靠话里点到短名来绑,默认关 */
      const repMsg = rep && conv.messages.find((m) => m.k === 'text' && m.id === rep.msgId) as TextMsg | undefined
      const ownerOf = (mid: string) => Object.values(computes).find((c) => c.reportMsg === mid || c.askMsg === mid)
      const viaQuote = rep && !broken('AC-40-9') ? (repMsg?.task ? computes[repMsg.task] : ownerOf(rep.msgId)) : undefined
      const viaShort = candidate('U88') && !rep ? Object.values(computes).find((c) => c.short && c.status !== 'done' && t.includes(c.short)) : undefined
      const bound = (viaQuote && viaQuote.status !== 'done' && !/通过|没问题|还要改|再改|返工/.test(t)) ? viaQuote : viaShort
      if (bound) {
        L.convs((cs) => cs.map((c) => ({ ...c, messages: c.messages.map((m) => (m.k === 'text' && m.id === id ? { ...m, tag: { task: bound.id, state: '已收到' } } : m)) })))
        addAct(bound.id, { step: Math.max(0, bound.steps.findIndex((x) => x.state === 'now')), kind: 'user', title: `你补了一句：${strip(t).slice(0, 40)}` })
        say(active, bound.owner, `收到，补进「${bound.short ?? bound.title}」，下一步一起改；别的事不动。`, 900, { task: bound.id } as never)
        return
      }
      const target = Object.values(people).find((p) => t.includes('@' + p.name))
      const peer = conv.kind === 'dm' ? conv.members.find((m) => m !== 'me') : undefined
      const who = target?.id ?? peer
      const bot = !!who && who !== 'me' && !people[who].human
      /* US12 ③ / AC-35:@ 一个接了外部来源的联系人说「总结一下」,回复第一行写明它总结的是哪一段(上次 @ 它到现在),没有上次就先问范围 */
      if (!broken('AC-35') && target && /总结一下|总结下|汇总一下/.test(t) && !q.length) {
        const src = target.id === 'argon' ? '飞书「产品讨论群」' : null
        if (src) {
          const lastAt = [...conv.messages].reverse().find((m) => m.k === 'text' && m.from === 'me' && m.id !== id && m.text.includes('@' + target.name))
          const from = lastAt && 'at' in lastAt && lastAt.at ? `今天 ${lastAt.at}` : lastAt ? '你上次 @ 我' : null
          if (!from) say(active, target.id as PersonId, `第一次让我总结${src}：从哪天开始算？默认从昨天 00:00。`, 900)
          else say(active, target.id as PersonId, `总结范围：${src}，从 ${from}（你上次 @ 我）到 现在，共 23 条。\n① 首版只接飞书，按勾选引用；② 有人提议加企业微信，还没结论；③ 下周三前出接入方案。`, 1000)
          return
        }
      }
      /* AC-19:你改了前提(算了 / 改成 / 不要了 / 换成),这个会话里还没回答的选项卡作废,标「已过期·未执行」,不会再按旧前提去做。
         别人插一句无关的话不会冲掉它 */
      if (!broken('AC-19') && /算了|改成|不要了|换成|先不做|改主意/.test(t)) L.pending((ps) => ps.map((p) => (p.kind === 'choice' && p.conv === active && !p.stale && (!target || p.from === target.id) ? { ...p, stale: id } : p)))
      /* U87:被 @ 的助手对这条消息给出交代。原型里先给「知道了」,它回复之后由它改成具体的处置 */
      if (!broken('AC-40') && bot) later(() => setDisp(id, { by: who as PersonId, kind: 'noted' }), 1300)
      /* #2862 起不再用表情标记已读:已读由回执按钮显示,联系人这一轮回复落盘时宿主推进它的已读位置(say → advanceRead)。
         坏实现(埋雷 AC-46-2):消息一写进账本、还在排队就把被 @ 的联系人记成已读(不等它接走)。 */
      if (broken('AC-46-2') && bot) s.advanceRead(active, who!, id)
      /* 坏实现(埋雷 AC-46-3):联系人点一个表情当已读(读回执时把点了表情的人算进已读) */
      if (broken('AC-46-3') && bot) later(() => L.reactions((r) => ({ ...r, [id]: { ...(r[id] ?? {}), [EYES]: [...new Set([...(r[id]?.[EYES] ?? []), who!])] } })), 500)
      /* D09.3 第 4 条:联系人正在跑上一轮时,这条先排队(回执未读),等它这一轮结束再被接走(回执变已读)。原型里排队 1.2 秒 */
      const busy = who && !people[who]?.human && conv.messages.some((m) => m.k === 'replying' && m.from === who)
      if (bot) setTimeout(() => say(active, who!, q.some((x) => x.ext) ? `收到，${q.length} 条外部消息我当参考看。` : '收到，我看一下。', 1100), busy && !frozen ? 1200 : 0)
    },
  }
}
