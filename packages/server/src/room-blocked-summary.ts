// D09.2④：会话列表投影待用户回答的实际阻塞原因，不生成新的待办或批准动作。
export interface RoomBlocker {
  readonly taskId: string;
  readonly seq: number;
  readonly text: string;
}

export function roomBlockedSummary(_items: readonly RoomBlocker[]): string | null {
  return "(未实现)";
}
