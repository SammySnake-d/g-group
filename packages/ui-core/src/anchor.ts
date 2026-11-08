// 消息悬浮工具条的定位(用户 #719:「消息悬浮的菜单项……根本不贴着消息，漂移太严重」)。
// 工具条挂在气泡本身(锚点)上,坐标相对锚点左上角:别人的消息放在气泡右侧外沿,
// 自己的消息放在左侧外沿(避开左下角的已读回执);放不下就换另一侧;两侧都放不下就压在气泡右上角。

export type Rect = { left: number; top: number; right: number; bottom: number };
export type Size = { width: number; height: number };
export type BarSide = "after" | "before" | "inside";
export type BarPlacement = { x: number; y: number; side: BarSide };

export const BAR_GAP = 6;

/** 计算工具条相对锚点的位置。mine = 自己发的(气泡靠右),reserveBefore = 气泡外侧要让出的宽度(已读回执)。 */
export function placeHoverBar(anchor: Rect, bar: Size, bounds: Rect, mine: boolean, reserveBefore = 0): BarPlacement {
  const aw = anchor.right - anchor.left;
  const ah = anchor.bottom - anchor.top;
  const afterX = aw + BAR_GAP;
  const beforeX = -bar.width - BAR_GAP - reserveBefore;
  const fitsAfter = anchor.left + afterX + bar.width <= bounds.right;
  const fitsBefore = anchor.left + beforeX >= bounds.left;
  // 矮气泡:和气泡垂直居中;高气泡:和第一行对齐(顶边内缩 2px),不随气泡高度往下漂
  const outsideY = ah <= bar.height + 12 ? Math.round((ah - bar.height) / 2) : 2;
  let side: BarSide;
  if (mine) side = fitsBefore ? "before" : fitsAfter ? "after" : "inside";
  else side = fitsAfter ? "after" : fitsBefore ? "before" : "inside";
  let x: number;
  let y: number;
  if (side === "after") {
    x = afterX;
    y = outsideY;
  } else if (side === "before") {
    x = beforeX;
    y = outsideY;
  } else {
    // 压在气泡右上角,一半露出顶边;别把它推出可视区左右
    x = Math.min(Math.max(aw - bar.width - 8, bounds.left - anchor.left + 4), bounds.right - anchor.left - bar.width - 4);
    y = -Math.round(bar.height / 2);
  }
  // 纵向:气泡上半截滚出可视区时,工具条贴着可视区顶边,但不越过气泡底边
  const minY = bounds.top - anchor.top + 4;
  const maxY = ah - bar.height;
  if (y < minY) y = Math.min(minY, Math.max(maxY, y));
  return { x, y, side };
}

/** 工具条和锚点之间的最短距离(两矩形不相交时的间隙,相交为 0),用来验证「贴着」。 */
export function gapBetween(a: Rect, b: Rect): number {
  const dx = Math.max(0, b.left - a.right, a.left - b.right);
  const dy = Math.max(0, b.top - a.bottom, a.top - b.bottom);
  return Math.hypot(dx, dy);
}
