// 默认的五块重拼(需求文档 D06 §2)。内核的 assembleRound 合入后由宿主改用它;这里先给闭环一个可跑的最小实现,
// 形状完全按 runtime-ports 的 RoundRequest:块号 1–5 固定顺序,只有第 1 块末尾是缓存断点,第 1 块不放任何易变内容。
import { BLOCK_LABELS, type BlockNo, type Inbound, type RoundBlock, type RoundRequest } from "@g-group/kernel";

export interface LedgerLine {
  readonly id: string;
  readonly roomId: string;
  readonly sourceSeq: number;
  readonly taskId: string;
  readonly text: string;
  readonly status: string;
}
export interface AssembleContext {
  readonly system: string;
  readonly tools: string;
  readonly persona: string;
  /** 各会话的群公告/规矩原文,按会话 id 排序后放进第 1 块。 */
  readonly roomRules: readonly { readonly roomId: string; readonly title: string; readonly rules: string }[];
  readonly ledger: readonly LedgerLine[];
  readonly stateNote: string | null;
  readonly fresh: readonly Inbound[];
  /** 在途任务一行摘要(第 5 块指针)。 */
  readonly tasks: readonly string[];
  /** 被引用消息原文(第 5 块按需换入)。 */
  readonly pointers: readonly { readonly ref: string; readonly text: string }[];
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
].join("\n");

export const CONTACT_TOOLS = [
  "reply(roomId, text, replyToSeq?) — 在会话里发言",
  "dispatch(roomId, sourceSeq, title, task) — 开 Compute 执行任务",
  "commit(roomId, sourceSeq, text, taskId?) — 登记承诺",
  "forward(taskId, text) — 转给在途 Compute",
  "deliver(taskId, text) — 交付任务结果",
  "stop(taskId) — 停止任务",
].join("\n");
