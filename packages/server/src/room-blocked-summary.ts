export interface BlockedItem {
  readonly taskId: string;
  readonly seq: number;
  readonly text: string;
}

const takeCodePoints = (text: string, max: number) => {
  const points = [...text];
  return points.length <= max ? text : `${points.slice(0, max).join("")}…`;
};

/** Stable room-level projection: earliest question first, with a bounded complete suffix. */
export function roomBlockedSummary(items: readonly BlockedItem[]): string {
  if (!items.length) return null as unknown as string;
  const ordered = [...items].sort((a, b) => a.seq - b.seq || a.taskId.localeCompare(b.taskId));
  const suffix = ordered.length > 1 ? `（另有 ${ordered.length - 1} 项）` : "";
  const prefix = "等待你：";
  const available = 500 - [...prefix].length - [...suffix].length;
  if (available <= 0) return `${prefix}${suffix}`.slice(0, 500);
  const text = ordered[0]!.text.trim().replace(/\s+/g, " ");
  return `${prefix}${takeCodePoints(text, Math.max(0, available - ([...text].length > available ? 1 : 0)))}${suffix}`;
}
