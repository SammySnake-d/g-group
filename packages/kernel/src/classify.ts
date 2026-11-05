// 先机械后语义(AC-11)与固定枚举(AC-12):有 @、↩ #seq、版本号可判定时不调分类器;分类器只能出 E1..E10 或 Uncertain。

export const EVENT_CODES = ["E1", "E2", "E3", "E4", "E5", "E6", "E7", "E8", "E9", "E10"] as const;
export type EventCode = (typeof EVENT_CODES)[number];
export type Classification = EventCode | "Uncertain";

export interface InboundEvent {
  readonly text: string;
  readonly mentions?: readonly string[];
  readonly quotes?: readonly number[];
  /** 回复所绑定的版本号(如确认卡的 version),有就能机械判定 */
  readonly version?: number;
}
export type Cue = "mention" | "quote" | "version";
export type Classifier = (event: InboundEvent) => unknown;
export interface ClassifyResult {
  readonly event: Classification;
  readonly via: "mechanical" | "semantic";
  readonly cues: readonly Cue[];
  /** 分类器返回了枚举之外的东西时记下原值,结果按 Uncertain 处理 */
  readonly violation?: string;
}

const ALLOWED: ReadonlySet<string> = new Set<string>([...EVENT_CODES, "Uncertain"]);

function mechanicalCues(e: InboundEvent): Cue[] {
  const cues: Cue[] = [];
  if ((e.mentions?.length ?? 0) > 0) cues.push("mention");
  if ((e.quotes?.length ?? 0) > 0) cues.push("quote");
  if (typeof e.version === "number" && Number.isFinite(e.version)) cues.push("version");
  return cues;
}

const describe = (x: unknown) => (typeof x === "string" ? x : (JSON.stringify(x) ?? String(x)));

export function classifyInbound(event: InboundEvent, classifier: Classifier): ClassifyResult {
  const cues = mechanicalCues(event);
  // 版本号绑定的回复是对确认卡的人类答复(E6);@ 与引用都是带锚点的入站消息(E1)
  if (cues.length > 0) return { event: cues.includes("version") ? "E6" : "E1", via: "mechanical", cues };
  let raw: unknown;
  try { raw = classifier(event); } catch (err) {
    return { event: "Uncertain", via: "semantic", cues, violation: `classifier-threw: ${String(err)}` };
  }
  if (typeof raw === "string" && ALLOWED.has(raw)) return { event: raw as Classification, via: "semantic", cues };
  return { event: "Uncertain", via: "semantic", cues, violation: describe(raw) };
}
