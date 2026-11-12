// 状态笔记压缩的纯函数(D06 第 2 小节第 3 块、D25 第 8 节)。不做 I/O,不调用模型。
//   compactMaterial:联系人本轮没写状态笔记时,宿主交给压缩器的材料——本轮新输入原文(同第 4 块呈现)+ 联系人本轮每个动作。
//   scrubRetracted :撤回优先(AC-08)。状态笔记是模型写的摘要,可能抄进了后来被撤回的原文;每次落盘与装配前,
//                    把撤回原文的精确出现换成占位;去掉空白与零宽字符后仍能比对到(无法精确替换)就判 leaked,由宿主作废整份笔记。
//                    短于 RETRACT_MIN_CHARS 个字符(去空白后)的撤回原文不扫:笔记是摘要,「好的」「收到」这类短语会大量误伤正常用词;
//                    这些短文本本身也不再经第 4、5 块回到请求。
import { squash } from "./assemble.ts";
import { renderInboundText } from "./rounds.ts";
import type { Inbound, MindAction } from "./runtime-ports.ts";

export const RETRACT_MIN_CHARS = 4;
/** 精确替换撤回原文用的占位;找旧消息的正文过同一条规则时也用它(history-tools.ts) */
export const RETRACT_PLACEHOLDER = "〔已撤回内容已移除〕";
const PLACEHOLDER = RETRACT_PLACEHOLDER;

function renderAction(a: MindAction): string {
  switch (a.kind) {
    case "reply":
      return `- reply → ${a.roomId}${a.replyToSeq === null ? "" : ` ↩#${a.replyToSeq}`}:${a.text}\n`;
    case "dispatch":
      return `- dispatch → ${a.roomId} #${a.sourceSeq}「${a.title}」:${a.task}\n`;
    case "commit":
      return `- commit → ${a.roomId} #${a.sourceSeq}:${a.text}\n`;
    case "forward":
      return `- forward → 任务 ${a.taskId}:${a.text}\n`;
    case "deliver":
      return `- deliver → 任务 ${a.taskId}:${a.text}\n`;
    case "stop":
      return `- stop → 任务 ${a.taskId}\n`;
    case "verdict":
      return `- verdict → 任务 ${a.taskId} #${a.sourceSeq}:${a.verdict}${a.feedback === null ? "" : `(${a.feedback})`}\n`;
    case "remember":
      return `- remember「${a.title}」${a.relation === null ? "" : ` ${a.relation}→${a.target ?? "?"}`}:${a.text}\n`;
    case "memory-use":
      return `- memory-use ${a.id}:${a.good ? "好" : "不好"}${a.note === null ? "" : `(${a.note})`}\n`;
    case "rerun":
      return `- rerun → ${a.roomId}${a.basisSeq === null ? "" : ` #${a.basisSeq}`}:单元 ${a.runId}\n`;
  }
}

/** 压缩材料:本轮新输入原文 + 联系人本轮动作。同样的输入得到逐字节相同的文本 */
export function compactMaterial(fresh: readonly Inbound[], actions: readonly MindAction[]): string {
  let t = "[本轮新输入(原文)]\n";
  t += fresh.length === 0 ? "(无)\n" : fresh.map(renderInboundText).join("");
  t += "[联系人本轮动作]\n";
  t += actions.length === 0 ? "(无)\n" : actions.map(renderAction).join("");
  return t;
}

/** 从状态笔记里移除撤回原文。hits:精确替换的次数;leaked:替换后去空白比对仍命中某条撤回原文 */
export function scrubRetracted(note: string, retracted: readonly string[]): { text: string; hits: number; leaked: boolean } {
  let text = note;
  let hits = 0;
  const needles: string[] = [];
  for (const raw of retracted) {
    const sq = squash(raw);
    if ([...sq].length < RETRACT_MIN_CHARS) continue;
    needles.push(sq);
    // 整段精确出现,再逐行(多行原文被模型分行抄写时)
    const pieces = [raw.trim(), ...raw.split(/\r?\n/).map((l) => l.trim()).filter((l) => [...squash(l)].length >= RETRACT_MIN_CHARS)];
    for (const p of pieces) {
      if (p === "") continue;
      const parts = text.split(p);
      if (parts.length > 1) {
        hits += parts.length - 1;
        text = parts.join(PLACEHOLDER);
      }
    }
  }
  const hay = squash(text);
  const leaked = needles.some((n) => hay.includes(n));
  return { text, hits, leaked };
}
