// 默认的五块重拼(需求文档 D06 §2)。内核的 assembleRound 合入后由宿主改用它;这里先给闭环一个可跑的最小实现,
// 形状完全按 runtime-ports 的 RoundRequest:块号 1–5 固定顺序,只有第 1 块末尾是缓存断点,第 1 块不放任何易变内容。
import { BLOCK_LABELS, type BlockNo, type Inbound, type RoundBlock, type RoundRequest, STATE_NOTE_GUIDE, assembleRound } from "@g-group/kernel";

export interface LedgerLine {
  readonly id: string;
  readonly roomId: string;
  readonly sourceSeq: number;
  readonly taskId: string;
  readonly text: string;
  readonly status: string;
}
export interface AssembleContext {
  /** 各会话 processed_seq;内核装配用它拒绝旧消息混进第 4 块(AC-40 ⑪)。 */
  readonly processedSeq?: Readonly<Record<string, number>>;
  /** 本轮绑定的承诺 id(新消息或 Compute 事件涉及的),放详情原文;其余一行索引。 */
  readonly boundIds?: readonly string[];
  readonly stateNoteVersion?: number;
  readonly system: string;
  readonly tools: string;
  readonly persona: string;
  /** 各会话的群公告/规矩原文,按会话 id 排序后放进第 1 块。 */
  readonly roomRules: readonly { readonly roomId: string; readonly title: string; readonly rules: string; readonly version?: number }[];
  readonly ledger: readonly LedgerLine[];
  readonly stateNote: string | null;
  readonly fresh: readonly Inbound[];
  /** 在途任务一行摘要(第 5 块指针)。 */
  readonly tasks: readonly string[];
  /** 被引用消息原文(第 5 块按需换入)。 */
  readonly pointers: readonly { readonly ref: string; readonly text: string }[];
  /** 整轮五块的字节预算;不给用 ROUND_BUDGET_BYTES。数值待决(需求文档 v3.20 §8.1 待决 13)。 */
  readonly budgetBytes?: number;
  /** 联系人的全局记忆快照(D25 第 6 节):进第 1 块;中途变化由宿主放进 pointers,不改这里。 */
  readonly memories?: readonly { readonly id: string; readonly title: string; readonly text: string }[];
  /** 运行台账里这位联系人按可见范围看得到的单元,一行一个(第 5 块,AC-43 ④;宿主机械过滤)。 */
  readonly runs?: readonly string[];
}
export type RoundAssembler = (ctx: AssembleContext) => RoundRequest;

export function identityOf(contactId: string, c: { name: string; persona: string }): string {
  return [`你是「${c.name}」(联系人 id ${contactId})。消息里的 @ 列的是联系人 id。`, c.persona].filter((x) => x.trim()).join("\n");
}

const TASK_BOARD_POLICY = "群清单有任务时，先用 read_task 读要求、负责人和版本。有人招领就用 claim_task 带读到的版本和接单话，已有负责人时让位。放弃自己名下的任务用 release_task，带版本和群内说明。交付按原流程，需要其他联系人时按群里的 @ 规则发消息。";

const block = (n: BlockNo, text: string): RoundBlock => ({ block: n, label: BLOCK_LABELS[n], text, cacheBreakpoint: n === 1 });

export function renderInbound(i: Inbound): string {
  switch (i.kind) {
    case "message": {
      const extra = [
        i.replyToSeq !== null ? `回复 #${i.replyToSeq}` : "",
        i.quotedSeqs.length ? `引用 ${i.quotedSeqs.map((s) => `#${s}`).join(" ")}` : "",
        i.mentions.length ? `@收件人：${i.mentions.join(" ")}` : "",
        i.command ? `命令 /${i.command.name} ${JSON.stringify(i.command.args)}` : "",
      ].filter(Boolean);
      return `[${i.roomId} #${i.seq}] ${i.sender.name}(${i.sender.kind}:${i.sender.id})${extra.length ? `〔${extra.join(";")}〕` : ""}: ${i.text}`;
    }
    case "compute":
      return `[${i.roomId}] 任务 ${i.taskId} 的 Compute ${i.computeId} 报告 ${i.signal}: ${i.summary}`;
    case "schedule":
      return `[${i.roomId}] 定时 ${i.scheduleId} 触发: ${i.prompt}`;
    case "claim-conflict":
      return `[${i.roomId}] 认领任务 ${i.taskId} 未成功：${i.summary}`;
  }
}

export const defaultAssemble: RoundAssembler = (ctx) => {
  const rules = [...ctx.roomRules].sort((a, b) => (a.roomId < b.roomId ? -1 : a.roomId > b.roomId ? 1 : 0));
  const prefix = [
    ctx.system,
    `## 工具\n${ctx.tools}`,
    `## 人设\n${ctx.persona || "(未设置)"}`,
    `## 会话规矩\n${rules.map((r) => `### ${r.title}(${r.roomId})\n${r.rules || "(无)"}`).join("\n") || "(无)"}`,
  ].join("\n\n");
  const ledger = ctx.ledger.length
    ? ctx.ledger.map((c) => `- ${c.id} [${c.status}] 来源 ${c.roomId} #${c.sourceSeq} 任务 ${c.taskId}: ${c.text}`).join("\n")
    : "(没有未了结的承诺)";
  const basedOnSeq: Record<string, number> = {};
  for (const i of ctx.fresh) if (i.kind === "message") basedOnSeq[i.roomId] = Math.max(basedOnSeq[i.roomId] ?? 0, i.seq);
  const pointers = [
    ctx.tasks.length ? `在途任务:\n${ctx.tasks.map((t) => `- ${t}`).join("\n")}` : "在途任务:无",
    ...(ctx.runs?.length ? [`运行台账(你在这些会话里看得到的单元):\n${ctx.runs.map((r) => `- ${r}`).join("\n")}`] : []),
    ...(ctx.tasks.length ? [TASK_BOARD_POLICY] : []),
    ...ctx.pointers.map((p) => `${p.ref} 原文:${p.text}`),
  ].join("\n");
  return {
    blocks: [
      block(1, prefix),
      block(2, ledger),
      block(3, ctx.stateNote ?? "(还没有状态笔记)"),
      block(4, ctx.fresh.map(renderInbound).join("\n") || "(没有新消息)"),
      block(5, pointers),
    ],
    basedOnSeq,
  };
};

export const CONTACT_SYSTEM = [
  "你是通讯录联系人,在私聊或群聊里与用户及他人协作。",
  "仅通过工具行动:reply 发言;第 5 块已有待认领任务先 read_task 读要求与版本,再用 claim_task 认领开工(勿用 dispatch_compute 重建);新活需命令或改文件用 dispatch_compute(你无 shell);commit 记承诺(原文须出自来源);forward 转补充给 Compute;deliver 交付;stop 停止。",
  "Compute 进度择要 reply,完成后用 deliver 交付(正文直发会话,不要再用 reply 重复),勿编造进展。",
  "第 5 块「运行台账」为真实状态;报 stalled 须在会话里说清卡点。",
  "rerun 只重跑失败/中断/未完单元:自己名下可自跑(有上限),他人名下须本轮明确要求(带 basisSeq),人停不重跑。",
  "群里只 @ 别人没 @ 你或有人已接手，别接活。没有新信息别抢答，有新信息可补充。点名写 @准确名字，后接标点或空格。引用作背景，按第4块答。",
  "普通任务 deliver 即完成,无需等通过(代码工作树任务除外)。提出者交付后若要求修改、改格式或重做,必须先用 verdict(revise) 带原话重开交给 Compute 修订再重新 deliver,不要仅用 reply 改写文字替代(明确说通过可选 accept)。sourceSeq 须为提出者交付后本人消息。",
  "每轮结束前用 update_state_note 写状态笔记(下轮不保留本轮原消息)。",
  STATE_NOTE_GUIDE,
  "Compute 受阻需用户(如验证码)时,宿主已发提问卡并附截图;用户回复后用 forward 原样转交,勿猜答或替答。",
].join("\n");

export const CONTACT_TOOLS = [
  "reply(roomId, text, replyToSeq?) — 在会话里发言",
  "read_task(taskId) — 读清单已有任务要求与版本",
  "claim_task(taskId, expectedRevision, text) — 认领待认领任务并附接单话",
  "release_task(taskId, expectedRevision, text) — 放弃自己名下任务认领",
  "dispatch(roomId, sourceSeq, title, task) — 开 Compute 执行新任务",
  "commit(roomId, sourceSeq, text, taskId?) — 登记承诺",
  "forward(taskId, text) — 转给在途 Compute",
  "deliver(taskId, text) — 交付任务结果(普通任务交付即完成)",
  "stop(taskId) — 停止任务",
  "verdict(taskId, sourceSeq, accept|revise, feedback?) — 交付后要改必须用 revise 重开返工(勿仅 reply);可选 accept",
  "update_state_note(note) — 写状态笔记(下一轮第 3 块)",
  "remember(roomId, title, text, anchors, sourceSeq?, quote?, relation?, target?) — 记下记忆(即生效)",
  "memory_feedback(id, good, note?) — 反馈记忆效果",
  "read_memory(id) — 读记忆全文",
  "read_quote_parent(roomId, seq) — 读上一级引用",
  "rerun(runId, roomId, basisSeq?) — 重跑未完成单元",
  "query_history(query|roomId+seq) — 查旧消息(仅参考)",
].join("\n");

/** 预算:整个请求(五块文本之和)的 UTF-8 字节上限。超了显式失败,不静默截断(D06 §2)。数值待决(需求文档 v3.20 §8.1 待决 13),宿主可用参数覆盖。 */
export const ROUND_BUDGET_BYTES = 400_000;
/** 单轮回读预算 max_recall(第 5 块被引用原文的 UTF-8 字节合计,D06.3 第 3–4 条)。数值待决(同上),宿主可用参数覆盖。 */
export const RECALL_BUDGET_BYTES = 64_000;
/** 每条有效引用的保底切片 min_slice_per_quote(UTF-8 字节,D06.3 第 4 条)。数值待决(同上)。 */
export const RECALL_MIN_SLICE_BYTES = 512;

/** 五块装配失败(超预算、输入不合格等):带内核给的原因,宿主据此显式失败,不截断、不吞。 */
export class RoundAssembleError extends Error {
  readonly reason: string;
  readonly need: number | null;
  readonly budget: number | null;
  constructor(reason: string, detail: string, need: number | null = null, budget: number | null = null) {
    super(`五块装配失败(${reason}):${detail}`);
    this.reason = reason;
    this.need = need;
    this.budget = budget;
  }
}

/**
 * 内核 assembleRound 的宿主适配:宿主状态 → RoundAssembleInput。
 * 会话规矩暂以「规矩版本号」当 sourceSeq 放进第 1 块规矩槽(规矩原文按原样、不扫会变内容);
 * 等规矩改由群里确认的消息登记(D06 §2 第 1 块「R1 Confirmed 规矩与用户纠正」)后换成来源消息 seq。
 */
export const kernelAssemble: RoundAssembler = (ctx) => {
  const r = assembleRound({
    prefix: {
      system: ctx.system,
      tools: ctx.tools,
      persona: ctx.persona,
      roomNotice: "",
      rules: ctx.roomRules
        .filter((x) => x.rules.trim())
        .map((x) => ({ id: `room-rules:${x.roomId}`, kind: "rule" as const, sourceSeq: Math.max(1, x.version ?? 1), text: `${x.title}:${x.rules}` })),
      ...(ctx.memories && ctx.memories.length > 0 ? { memories: [...ctx.memories] } : {}),
    },
    ledger: {
      open: ctx.ledger.map((l) => ({ id: l.id, sourceSeq: l.sourceSeq, taskId: l.taskId.startsWith("standing-") ? null : l.taskId, text: l.text, status: l.status })),
      boundIds: [...(ctx.boundIds ?? [])],
    },
    stateNote: ctx.stateNote === null ? null : { version: ctx.stateNoteVersion ?? 1, text: ctx.stateNote },
    processedSeq: { ...(ctx.processedSeq ?? {}) },
    fresh: [...ctx.fresh],
    pointers: [...(ctx.tasks.length ? [{ ref: "群清单操作", text: TASK_BOARD_POLICY }] : []), ...ctx.tasks.map((t) => ({ ref: `在途任务 ${t.split(" ")[0]}`, text: t })), ...(ctx.runs ?? []).map((r) => ({ ref: `运行台账 ${r.split(" ")[0]}`, text: r })), ...ctx.pointers],
    budgetBytes: ctx.budgetBytes ?? ROUND_BUDGET_BYTES,
  });
  if (!r.ok) throw r.reason === "over-budget" ? new RoundAssembleError(r.reason, r.detail, r.need, r.budget) : new RoundAssembleError(r.reason, r.detail);
  return r.request;
};
