// D09.2④：会话列表投影待用户回答的实际阻塞原因，不生成新的待办或批准动作。
export interface RoomBlocker {
  readonly taskId: string;
  readonly seq: number;
  readonly text: string;
}

export function roomBlockedSummary(items: readonly RoomBlocker[]): string | null {
  const ordered = [...items].sort((a, b) => a.seq - b.seq || a.taskId.localeCompare(b.taskId));
  const first = ordered[0];
  if (!first) return null;
  const text = first.text.replace(/\s+/g, " ").trim();
  const suffix = ordered.length > 1 ? `（另有 ${ordered.length - 1} 项）` : "";
  const prefix = "等待你：";
  const line = `${prefix}${text}${suffix}`;
  if (line.length <= 500) return line;
  // 给完整尾注与省略号预留空间；合同按 UTF-16 长度计数，不截开代理对。
  const clipped = text.slice(0, 499 - prefix.length - suffix.length).replace(/[\uD800-\uDBFF]$/u, "");
  return `${prefix}${clipped}…${suffix}`;
}
