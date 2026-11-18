export interface BlockedItem {
  readonly taskId: string;
  readonly seq: number;
  readonly text: string;
}

/** Red specification placeholder for the P2-A1 room summary projection. */
export function roomBlockedSummary(_items: readonly BlockedItem[]): string | null {
  return null;
}
