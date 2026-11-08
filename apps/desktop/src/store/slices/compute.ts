// Compute 与待你处理切片:回答提问、验收/退回、失败重试/跳过、写盘授权、停止/继续/补充/回滚、卡在验证码时交给你。
import { computes0, pending0, type Activity, type Compute } from '@/data'
import { broken } from '@/mut'
import { clock, frozen, later, uid } from '../boot'
import { lens, type Slice } from '../state'
import type { Ctx } from '../types'

export type ComputeSlice = Pick<Ctx, 'computes' | 'pending' | 'answers' | 'resolve' | 'stop' | 'resume' | 'tell' | 'rollback' | 'hitCaptcha' | 'declineHuman' | 'takeHuman' | 'returnHuman'> & {
  /** 给某件 Compute 的过程追加一条(之前的「进行中」都收起) */
  addAct: (cid: string, a: Omit<Activity, 'id' | 'at'>) => void
}

export const createComputeSlice: Slice<ComputeSlice> = (set, get) => {
  const L = lens(set)
  const patch = (cid: string, f: (c: Compute) => Partial<Compute>) => L.computes((cs) => ({ ...cs, [cid]: { ...cs[cid], ...f(cs[cid]) } }))
  const nowStep = (c: Compute) => Math.max(0, c.steps.findIndex((s) => s.state === 'now'))
  const me = (text: string, cid: string, extra?: object) => get().pushMsg({ k: 'text', id: 'me-' + uid(), from: 'me', text, ...extra }, cid)

  return {
    computes: computes0,
    pending: pending0,
    answers: {},

    addAct: (cid, a) => L.computes((cs) => ({ ...cs, [cid]: { ...cs[cid], activity: [...cs[cid].activity.map((x) => ({ ...x, live: false })), { ...a, id: 'x' + uid(), at: '刚刚' } as Activity] } })),

    resolve: (pid, action, value) => {
      const { pending, computes, pushMsg, say, addAct } = get()
      const p = pending.find((x) => x.id === pid)
      if (!p) return
      L.pending((ps) => ps.filter((x) => x.id !== pid))
      if (p.kind === 'choice') {
        const chosen = typeof value === 'number' ? p.options[value]! : String(value)
        const replyId = 'me-' + uid()
        L.answers((a) => ({ ...a, [p.ask]: { title: p.title, options: p.options, picked: chosen, at: clock(), replyId } }))
        pushMsg({ k: 'text', id: replyId, from: 'me', text: chosen, answerTo: p.ask, quotes: [{ msgId: p.ask, from: p.from, text: p.title, reply: true }] }, p.conv)
        say(p.conv, p.from, '好，按这个来。我先写接入方案，写完发在这里。')
      } else if (p.kind === 'accept') {
        const c = computes[p.computeId]
        if (action === 'ok') {
          patch(c.id, (x) => ({ status: 'done', phase: '已完成', steps: x.steps.map((s) => ({ ...s, state: 'done' })) }))
          me(`「${c.title}」验收通过`, p.conv)
          say(p.conv, c.owner, '收到，这件事结束了。', 700)
        } else {
          patch(c.id, (x) => ({ status: 'running', phase: '等你说要改哪里', steps: x.steps.map((s, i, arr) => (i === arr.length - 1 ? { ...s, state: 'todo' } : s)) }))
          me(`「${c.title}」还要改`, p.conv)
          say(p.conv, c.owner, '好，你想改哪里？直接说，我接着原来那个 Compute 改，之前的过程都还在。', 700)
        }
      } else if (p.kind === 'error') {
        const c = computes[p.computeId]
        if (action === 'retry' || action === 'switch') {
          patch(c.id, (x) => ({ status: 'running', phase: action === 'switch' ? '换 Claude Sonnet 5.5 重试' : '重新打开网页', model: action === 'switch' ? 'Claude Sonnet 5.5' : x.model, steps: x.steps.map((s) => (s.state === 'fail' ? { ...s, state: 'now' } : s)) }))
          later(() => {
            patch(c.id, (x) => ({ status: 'done', phase: '已完成', result: '要点整理好了', steps: x.steps.map((s) => ({ ...s, state: 'done' })) }))
            get().say(p.conv, c.owner, '重试成功，文章要点整理好了：层级靠字重和灰度，不靠颜色；系统事件只占一行。', 400)
          }, 3000)
        } else {
          /* AC-36:跳过这一步,接着做后面的,汇报里写明跳过了什么 */
          const failed = c.steps.find((x) => x.state === 'fail')?.text ?? '这一步'
          patch(c.id, (x) => ({ status: 'done', phase: '已完成（有跳过）', result: `跳过了「${failed}」`, steps: x.steps.map((s) => ({ ...s, state: 'done' })) }))
          say(p.conv, c.owner, `好，跳过「${failed}」。按已有的地址和摘要先整理了要点；跳过了：${failed}，原文没读到，结论待核实。`, 600)
        }
      } else if (p.kind === 'proposal' && p.gate) {
        /* AC-17 / AC-20:只有你本人同意才放行,而且只放行这一次;下一次写盘还会再问。
           #2435:点按钮或在对话里亲口说一句「同意」都算;value === 'said' 表示是你刚打字说的,那条消息已经发了,不再补一条 */
        if (value !== 'said') {
          const replyId = 'me-' + uid(), picked = action === 'ok' ? '同意，改吧' : '先别改'
          L.answers((a) => ({ ...a, [p.ask!]: { title: p.title, options: ['同意，改吧', '先别改'], picked, at: clock(), replyId } }))
          pushMsg({ k: 'text', id: replyId, from: 'me', text: picked, answerTo: p.ask!, quotes: [{ msgId: p.ask!, from: p.from, text: p.title, reply: true }] }, p.conv)
        }
        if (action === 'ok') {
          addAct(p.gate, { step: nowStep(computes[p.gate]), kind: 'edit', title: `你同意后写入：${p.title}（只放行这一次）` })
          say(p.conv, p.from, '收到，写进去了。下次要改代码还会先问你。', 700)
        } else say(p.conv, p.from, '好，不改，这条要求先记着。', 700)
      } else if (p.kind === 'proposal') {
        const replyId = 'me-' + uid(), picked = action === 'ok' ? '同意' : '先不改'
        if (p.ask) L.answers((a) => ({ ...a, [p.ask!]: { title: p.title, options: ['同意', '先不改'], picked, at: clock(), replyId } }))
        pushMsg({ k: 'text', id: replyId, from: 'me', text: `${picked}：${p.title}`, ...(p.ask ? { answerTo: p.ask } : {}) }, p.conv)
      }
    },

    /* AC-23:停止分两步。按下只是「请求停止」,等当前那条命令真的结束、进程确认停了,才算停下并归还算力;不提前归还 */
    stop: (cid) => {
      const at = get().computes[cid].steps.findIndex((s) => s.state === 'now')
      if (broken('AC-23')) { patch(cid, () => ({ status: 'stopped', phase: '已停止 · 算力已归还' })); return }
      patch(cid, () => ({ stopping: true, phase: '正在停止…等当前命令结束' }))
      get().addAct(cid, { step: at, kind: 'user', title: '你按了停止。正在等当前命令结束，结束前不会归还算力' })
      setTimeout(() => {
        patch(cid, () => ({ stopping: false, status: 'stopped', phase: '已停止 · 算力已归还' }))
        get().addAct(cid, { step: at, kind: 'user', title: '进程已确认停止，算力已归还。已经改的文件保留，可以继续或回到检查点' })
      }, frozen ? 600 : 1800)
    },
    resume: (cid) => {
      const step = nowStep(get().computes[cid])
      patch(cid, () => ({ status: 'running', phase: '继续' }))
      get().addAct(cid, { step, kind: 'user', title: '你让它继续' })
    },
    tell: (cid, text, side) => {
      const c = get().computes[cid]
      const step = nowStep(c)
      get().addAct(cid, { step, kind: side ? 'ask' : 'user', title: side ? `你问：${text}` : `你补充：${text}（下一步生效）` })
      if (side) later(() => get().addAct(cid, { step, kind: 'answer', title: c.status === 'running' ? `答：正在${c.phase}，还剩 ${c.steps.filter((s) => s.state === 'todo').length + 1} 步，大约 3 分钟` : '答：已经做完，在等你回复' }), 900)
    },
    rollback: (cid, cpId) => {
      const cp = get().computes[cid].checkpoints.find((x) => x.id === cpId)!
      patch(cid, (x) => ({ status: 'stopped', phase: `回到「${cp.label}」`, steps: x.steps.map((s, i) => ({ ...s, state: i <= cp.step && cp.files ? 'done' : i === cp.step + 1 ? 'now' : 'todo' })) }))
      get().addAct(cid, { step: cp.step, kind: 'rollback', title: `回到检查点「${cp.label}」，之后的文件改动已恢复；过程记录保留` })
    },

    hitCaptcha: (cid) => {
      const c = get().computes[cid]; if (!c) return
      /* AC-44:卡在人工验证码 → 进 BlockedOnHuman(不重试、不猜、不绕过);由联系人 @你 并附截图,Compute 不直接发言 */
      const qid = 'q' + uid()
      patch(cid, () => ({ phase: '卡在验证码，等你', needsHuman: broken('AC-44') ? undefined : { what: '登录页要输入短信验证码', qid } }))
      if (broken('AC-44-retry')) get().addAct(cid, { step: 1, kind: 'cmd', title: '自动重试提交验证码（第 2 次）' })
      else get().addAct(cid, { step: 1, kind: 'user', title: '遇到短信验证码：停在这一步等你，不重试、不绕过' })
      if (!broken('AC-44')) get().say(c.conv, c.owner, `@39impacts 登录要短信验证码，这一步得你来：点「我来输入」接手浏览器，输完点「交还」我接着查；不方便就点「不做了」。`, 400, { shot: { title: '运维后台登录页 · 要短信验证码', compute: cid } })
    },
    takeHuman: (cid) => {
      patch(cid, (x) => ({ needsHuman: x.needsHuman && { ...x.needsHuman, taken: true }, phase: '你在操作浏览器' }))
      set({ pip: cid })
    },
    /* AC-44④:你拒绝 → 取消任务、释放算力 */
    declineHuman: (cid) => {
      const c = get().computes[cid]; if (!c) return
      patch(cid, () => ({ needsHuman: undefined, status: 'stopped', phase: '你不做验证，已取消 · 算力已归还' }))
      set({ pip: null })
      get().addAct(cid, { step: 1, kind: 'user', title: '你选了不做验证。任务已取消，算力已归还' })
      get().say(c.conv, c.owner, '好，这件先不查了，已经取消。', 400)
    },
    /* AC-44⑤:任务已取消、或这次求助已经过期,迟到的交还幂等忽略 */
    returnHuman: (cid) => {
      const c = get().computes[cid]; if (!c) return
      if (!broken('AC-44-late') && (!c.needsHuman || c.status !== 'running')) { get().toast('这件已经取消了，这次交还不再送给它'); return }
      patch(cid, (x) => ({ needsHuman: undefined, phase: '登录好了，在查 02:00 前后的报错', steps: x.steps.map((s, i) => (i === 1 ? { ...s, state: 'done' } : i === 2 ? { ...s, state: 'now' } : s)) }))
      set({ pip: null })
      get().say(c.conv, c.owner, '收到，已经登进去了，我接着查。', 400)
    },
  }
}
