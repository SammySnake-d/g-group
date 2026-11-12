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
  const line = `等待你：${text}${suffix}`;
  return line.length <= 500 ? line : `${line.slice(0, 499)}…`;
}
