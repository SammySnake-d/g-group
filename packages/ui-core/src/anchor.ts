// 消息悬浮工具条的定位。
// 用户 #719:「消息悬浮的菜单项……根本不贴着消息，漂移太严重」——工具条挂在气泡本身(锚点)上,不相对整列漂。
// 用户 #1032(需求变更):「用户想要回复，肯定是先移动到需要回复的消息上……为什么不能做成更贴近消息体的，在消息上方的设计呢？这样不是移动路径更短吗？」
// 照 mirasim 消息工具条的「over」放置(右上角压边):工具条底边压进气泡顶边 BAR_OVERLAP,右边比气泡右边缩进 BAR_INSET;
// 自己的消息和别人的消息都放在气泡末端那一角(右上)。气泡顶上的位置被可视区顶边挡住时,退到气泡下方(右下角压边);
// 上下都放不下(很高的气泡只露出中间一截)就贴着可视区顶边压在气泡里。坐标相对锚点左上角。

export type Rect = { left: number; top: number; right: number; bottom: number };
export type Size = { width: number; height: number };
export type BarSide = "top" | "bottom" | "pinned";
export type BarPlacement = { x: number; y: number; side: BarSide };

/** 工具条压进气泡边缘的深度(mirasim:bottom-[calc(100%-8px)] / top-[calc(100%-8px)]) */
export const BAR_OVERLAP = 8;
/** 工具条右边比气泡右边缩进的距离(mirasim:right-2) */
export const BAR_INSET = 8;
/** 工具条离可视区边缘至少留出的距离(mirasim 判断上方放不放得下时多留 4px) */
export const BAR_EDGE = 4;

/** 计算工具条相对锚点的位置。bounds = 可视区(聊天滚动区与窗口的交集)。 */
export function placeHoverBar(anchor: Rect, bar: Size, bounds: Rect): BarPlacement {
  const aw = anchor.right - anchor.left;
  const ah = anchor.bottom - anchor.top;
  // 水平:右边对齐气泡末端(缩进 BAR_INSET);气泡比工具条窄时向左伸出,但不出可视区
  const minX = bounds.left - anchor.left + BAR_EDGE;
  const maxX = bounds.right - anchor.left - bar.width - BAR_EDGE;
  const x = Math.max(minX, Math.min(aw - bar.width - BAR_INSET, maxX));
  // 竖直:优先放在上方压边;上方被可视区顶边挡住就放下方压边;都不行就贴可视区顶边压在气泡里
  const topY = BAR_OVERLAP - bar.height;
  if (anchor.top + topY >= bounds.top + BAR_EDGE) return { x, y: topY, side: "top" };
  const bottomY = ah - BAR_OVERLAP;
  if (anchor.top + bottomY + bar.height <= bounds.bottom - BAR_EDGE) return { x, y: bottomY, side: "bottom" };
  return { x, y: bounds.top - anchor.top + BAR_EDGE, side: "pinned" };
}

/** 工具条和锚点之间的最短距离(两矩形不相交时的间隙,相交为 0),用来验证「贴着」。 */
export function gapBetween(a: Rect, b: Rect): number {
  const dx = Math.max(0, b.left - a.right, a.left - b.right);
  const dy = Math.max(0, b.top - a.bottom, a.top - b.bottom);
  return Math.hypot(dx, dy);
}
