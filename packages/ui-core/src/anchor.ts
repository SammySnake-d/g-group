// 用户 #719:「消息悬浮的菜单项……根本不贴着消息，漂移太严重」——工具条挂在气泡本身(锚点)上,不相对整列漂。
// 用户 #1032(需求变更):「用户想要回复，肯定是先移动到需要回复的消息上……为什么不能做成更贴近消息体的，在消息上方的设计呢？这样不是移动路径更短吗？」

export type Rect = { left: number; top: number; right: number; bottom: number };
export type Size = { width: number; height: number };
export type BarSide = "top" | "bottom" | "pinned";
export type BarPlacement = { x: number; y: number; side: BarSide };

export const BAR_OVERLAP = 8;
export const BAR_INSET = 8;
export const BAR_EDGE = 4;

export function placeHoverBar(anchor: Rect, bar: Size, bounds: Rect): BarPlacement {
  const aw = anchor.right - anchor.left;
  const ah = anchor.bottom - anchor.top;
  const minX = bounds.left - anchor.left + BAR_EDGE;
  const maxX = bounds.right - anchor.left - bar.width - BAR_EDGE;
  const x = Math.max(minX, Math.min(aw - bar.width - BAR_INSET, maxX));
  const topY = BAR_OVERLAP - bar.height;
  if (anchor.top + topY >= bounds.top + BAR_EDGE) return { x, y: topY, side: "top" };
  const bottomY = ah - BAR_OVERLAP;
  if (anchor.top + bottomY + bar.height <= bounds.bottom - BAR_EDGE) return { x, y: bottomY, side: "bottom" };
  return { x, y: bounds.top - anchor.top + BAR_EDGE, side: "pinned" };
}

export function gapBetween(a: Rect, b: Rect): number {
  const dx = Math.max(0, b.left - a.right, a.left - b.right);
  const dy = Math.max(0, b.top - a.bottom, a.top - b.bottom);
  return Math.hypot(dx, dy);
}
