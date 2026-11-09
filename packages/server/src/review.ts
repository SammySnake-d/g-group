// 跨研发厂商独立审查(AC-26 / R-01):挑审查人、拼审查说明、读审查结论。纯函数,不做 I/O;宿主(host.ts)负责起审查 Compute 和推进状态机。
// 门禁本身在 @g-group/domain 的 T5 守卫里(审查人≠作者、审查厂商∉累积生产厂商、unknown 一律拒);这里挑人只是不去起注定被拒的审查。
// 实际审查模型取审查人起审查 Compute 用的模型(需求文档 D07「若审查人拉起了 Compute 跑审查,取其 Compute 模型」),不是它的说话模型。
import { vendorOf } from "@g-group/domain";

/** 审查 Compute 只给只读工具:看产物,不改产物。 */
export const REVIEW_TOOLS: readonly string[] = Object.freeze(["Read", "Glob", "Grep"]);

export interface ReviewCandidate {
  readonly contactId: string;
  /** 这位联系人起审查 Compute 时实际用的模型(它的 Compute 模型)。 */
  readonly model: string;
  /** 是不是任务所在会话的成员。 */
  readonly inRoom: boolean;
}

/**
 * 挑审查人:排除作者本人;审查模型厂商认不出(unknown)的排除;与累积生产模型(含半途换模,F13)任一同厂商的排除;
 * 生产模型为空或里面有 unknown 时谁都不能审(门禁判不了)。合格的里面同会话成员优先,其余按给定顺序。没有合格的返回 null。
 */
export function pickReviewer(candidates: readonly ReviewCandidate[], producerModels: readonly string[], ownerId: string | null): ReviewCandidate | null {
  const producers = new Set(producerModels.map(vendorOf));
  if (producers.size === 0 || producers.has("unknown")) return null;
  const ok = candidates.filter((c) => {
    const v = vendorOf(c.model);
    return c.contactId !== ownerId && v !== "unknown" && !producers.has(v);
  });
  return ok.find((c) => c.inRoom) ?? ok[0] ?? null;
}

/**
 * 实际审查模型是否合格(AC-26「不能只静态比对、忽略审查 Compute 实际模型」):harness 回报的每一个实际模型都要认得出厂商,
 * 且不在累积生产厂商里。有问题返回人话说明(点名是哪个模型、什么厂商),合格返回 null。一个都没有也算有问题。
 */
export function reviewModelProblem(models: readonly string[], producerModels: readonly string[]): string | null {
  if (models.length === 0) return "没有回报任何实际审查模型";
  const producers = new Set(producerModels.map(vendorOf));
  for (const m of models) {
    const v = vendorOf(m);
    if (v === "unknown") return `实际审查模型 ${m} 认不出研发厂商`;
    if (producers.has(v)) return `实际审查模型 ${m}(${v})与生产厂商 {${[...producers].join(",")}} 同源`;
  }
  return null;
}

/** 去掉 markdown 加粗、行内代码、引用与列表记号,只留文字。 */
const plainLine = (l: string): string => l.replace(/[*_`~]/g, "").replace(/^[\s>#\-•]+/, "").trim();
/** 结论行:以 APPROVE / REJECT 开头(完整的词),同一行冒号后是意见的开头。 */
const HEAD = /^(APPROVE|REJECT)\b[:：]?[ \t]*(.*)$/i;
/** 结论行:在冒号后以 APPROVE / REJECT 结尾(如「审查已完成并提交:APPROVE。」「结论:REJECT」)。 */
const TAIL = /[:：][ \t]*(APPROVE|REJECT)[ \t]*[。.!！]?$/i;
/**
 * 读审查结论:逐行去掉加粗等标记后,找以 APPROVE/REJECT 开头、或在冒号后以它结尾的结论行;第一条结论行之后的内容是意见。
 * 别处出现的同一个词(「我觉得 APPROVE」「不能 APPROVE」)不算;前后出现相反的结论行、或一条都没有,返回 null,不猜。
 */
export function parseVerdict(text: string): { verdict: "approve" | "reject"; notes: string } | null {
  const lines = text.split(/\r?\n/);
  let found: { verdict: "approve" | "reject"; notes: string } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const l = plainLine(lines[i]!);
    if (!l) continue;
    const h = HEAD.exec(l);
    const m = h ?? TAIL.exec(l);
    if (!m) continue;
    const verdict = m[1]!.toUpperCase() === "APPROVE" ? "approve" : "reject";
    if (found && found.verdict !== verdict) return null;
    found ??= { verdict, notes: [h ? h[2]! : "", ...lines.slice(i + 1)].join("\n").trim() };
  }
  return found;
}

/** 派给审查 Compute 的说明:要求原文、交付原文、只读检查、结论格式。 */
export function reviewBrief(input: { title: string; requirement: string; delivery: string }): string {
  return [
    `你是独立审查人,和做这件事的执行者来自不同的研发厂商。审查任务「${input.title}」的交付是否满足要求。`,
    `## 要求原文\n${input.requirement}`,
    `## 交付说明\n${input.delivery}`,
    "## 怎么审\n工作目录里就是产物。只读检查,不要修改、新建或删除任何文件。对照要求逐条核对,能核实的要实际打开文件看。",
    "## 怎么报\n审完后你的最终回复第一行只写 APPROVE 或 REJECT(不加粗、不加别的字),第二行起写理由;同样的内容用 report_progress 报 kind=completed。发现不满足要求的地方必须 REJECT,并写清要改什么。",
  ].join("\n\n");
}
