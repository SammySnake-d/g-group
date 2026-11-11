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

const block = (n: BlockNo, text: string): RoundBlock => ({ block: n, label: BLOCK_LABELS[n], text, cacheBreakpoint: n === 1 });

export function renderInbound(i: Inbound): string {
  switch (i.kind) {
    case "message": {
      const extra = [
        i.replyToSeq !== null ? `回复 #${i.replyToSeq}` : "",
        i.quotedSeqs.length ? `引用 ${i.quotedSeqs.map((s) => `#${s}`).join(" ")}` : "",
        i.mentions.length ? `@ ${i.mentions.join(" ")}` : "",
        i.command ? `命令 /${i.command.name} ${JSON.stringify(i.command.args)}` : "",
      ].filter(Boolean);
      return `[${i.roomId} #${i.seq}] ${i.sender.name}(${i.sender.kind}:${i.sender.id})${extra.length ? `〔${extra.join(";")}〕` : ""}: ${i.text}`;
    }
    case "compute":
      return `[${i.roomId}] 任务 ${i.taskId} 的 Compute ${i.computeId} 报告 ${i.signal}: ${i.summary}`;
    case "schedule":
      return `[${i.roomId}] 定时 ${i.scheduleId} 触发: ${i.prompt}`;
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
  "你是用户通讯录里的一位联系人,在私聊或群聊里和用户及其他联系人协作。",
  "你只能通过工具行动:reply 在会话里说话;dispatch 把需要跑命令、改文件、多轮试错的活交给你手下的 Compute(你自己不能跑 shell);",
  "commit 登记你答应要做的事(原文必须出自来源消息);forward 把用户的补充要求转给在途 Compute;deliver 在 Compute 完成后交付结果;stop 停止任务。",
  "收到 Compute 的进度时,值得告诉用户的用 reply 简短汇报;Compute 完成后用 deliver 交付,说清结果在哪。不要编造没有发生的进展。",
  "deliver 的 text 会原样作为交付消息发到会话里;交付时不要再用 reply 重复同样的内容。",
  "第 5 块「运行台账」是宿主核对的真实状态;Compute 报 stalled 即被判卡住或没跑完,在会话里说清卡在哪。",
  "rerun 只重跑失败/中断/没跑完的单元:自己名下的可自行重跑(有上限),别人名下的须本轮有人明确要求(basisSeq 写那条),人停的不重跑。",
  "群里一条消息 @ 了别的联系人、没 @ 你时,那件事归被 @ 的人:你不要接活、不要说「我来做」,宿主也会拒绝你为它开 Compute;同一条消息已有别人接手时同样不要再接。",
  "交付后等提出者本人回复:他明确说通过,用 verdict(accept) 记下;他说要改什么,用 verdict(revise) 并带上原话。sourceSeq 必须是他本人在交付之后发的那条;别人说的、转述的或交付之前的话都不算。没回复就一直等,不要自己当作通过。",
  "每轮结束前用 update_state_note 写状态笔记:下一轮你看不到这一轮的消息原文,只看得到状态笔记、承诺账本和新消息。",
  STATE_NOTE_GUIDE,
  "Compute 受阻需要用户(如验证码)时,宿主已替你在会话里 @提出者 发了提问卡并附截图;用户在聊天里回答后,用 forward 把回答原样转给 Compute,不要自己猜答案或替用户回答。",
].join("\n");

export const CONTACT_TOOLS = [
  "reply(roomId, text, replyToSeq?, mentions?) — 在会话里发言",
  "dispatch(roomId, sourceSeq, title, task) — 开 Compute 执行任务",
  "commit(roomId, sourceSeq, text, taskId?) — 登记承诺",
  "forward(taskId, text) — 转给在途 Compute",
  "deliver(taskId, text) — 交付任务结果",
  "stop(taskId) — 停止任务",
  "verdict(taskId, sourceSeq, accept|revise, feedback?) — 记下提出者对交付的回复:通过或要改",
  "update_state_note(note) — 写状态笔记(下一轮第 3 块)",
  "remember(roomId, title, text, anchors, sourceSeq?, quote?, relation?, target?) — 记下以后用得上的记忆(写下即生效)",
  "memory_feedback(id, good, note?) — 记一笔某条记忆这次用得好不好",
  "read_memory(id) — 按 id 读一条记忆全文",
  "read_quote_parent(roomId, seq) — 引用链往上读一级",
  "rerun(runId, roomId, basisSeq?) — 重跑运行台账里失败 / 中断 / 没跑完的单元",
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
    pointers: [...ctx.tasks.map((t) => ({ ref: `在途任务 ${t.split(" ")[0]}`, text: t })), ...(ctx.runs ?? []).map((r) => ({ ref: `运行台账 ${r.split(" ")[0]}`, text: r })), ...ctx.pointers],
    budgetBytes: ctx.budgetBytes ?? ROUND_BUDGET_BYTES,
  });
  if (!r.ok) throw r.reason === "over-budget" ? new RoundAssembleError(r.reason, r.detail, r.need, r.budget) : new RoundAssembleError(r.reason, r.detail);
  return r.request;
};
