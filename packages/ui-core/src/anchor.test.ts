import assert from "node:assert/strict";
import { test } from "node:test";
import { BAR_EDGE, BAR_INSET, BAR_OVERLAP, gapBetween, placeHoverBar } from "./anchor.ts";

// 需求变更 #1032:工具条放在消息上方、压住气泡顶边,水平对齐气泡末端(右上角),照 mirasim 的压边量
const bounds = { left: 0, top: 0, right: 900, bottom: 700 };
const bar = { width: 130, height: 32 };

test("placeHoverBar:别人的消息,工具条在气泡右上角——底边压进气泡顶边 8px,右边缩进 8px", () => {
  const anchor = { left: 60, top: 200, right: 360, bottom: 240 };
  const p = placeHoverBar(anchor, bar, bounds);
  assert.deepEqual(p, { x: 300 - 130 - BAR_INSET, y: BAR_OVERLAP - 32, side: "top" });
  // 换成页面坐标核对几何:工具条底边 = 气泡顶边 + 8;右边 = 气泡右边 - 8;和气泡相交(悬停链不断)
  const barBox = { left: anchor.left + p.x, top: anchor.top + p.y, right: anchor.left + p.x + 130, bottom: anchor.top + p.y + 32 };
  assert.equal(barBox.bottom - anchor.top, 8);
  assert.equal(anchor.right - barBox.right, 8);
  assert.equal(gapBetween(anchor, barBox), 0);
});

test("placeHoverBar:自己的消息同样放在右上角(不再放到气泡左侧,指针不用折返)", () => {
  const anchor = { left: 500, top: 100, right: 860, bottom: 138 };
  const p = placeHoverBar(anchor, bar, bounds);
  assert.equal(p.side, "top");
  assert.equal(p.x, 360 - 130 - BAR_INSET);
  assert.ok(anchor.left + p.x > anchor.left, "工具条在气泡水平范围内,不在左侧外沿");
});

test("placeHoverBar:高气泡也只压顶边,不随高度漂到中间", () => {
  const anchor = { left: 60, top: 100, right: 500, bottom: 420 };
  const p = placeHoverBar(anchor, bar, bounds);
  assert.equal(p.side, "top");
  assert.equal(p.y, BAR_OVERLAP - 32);
});

test("placeHoverBar:气泡比工具条窄时右边仍对齐末端,向左伸出;伸出可视区就夹回来", () => {
  const narrow = { left: 400, top: 200, right: 440, bottom: 236 };
  const p = placeHoverBar(narrow, bar, bounds);
  assert.equal(p.x, 40 - 130 - BAR_INSET);
  const nearLeft = { left: 20, top: 200, right: 60, bottom: 236 };
  const q = placeHoverBar(nearLeft, bar, bounds);
  assert.equal(nearLeft.left + q.x, bounds.left + BAR_EDGE);
});

test("placeHoverBar:气泡贴着可视区顶边时退到气泡下方(右下角压边)", () => {
  const anchor = { left: 60, top: 10, right: 400, bottom: 50 };
  const p = placeHoverBar(anchor, bar, bounds);
  assert.deepEqual(p, { x: 340 - 130 - BAR_INSET, y: 40 - BAR_OVERLAP, side: "bottom" });
  // 刚好放得下上方的边界:顶上留 4px
  const exact = { left: 60, top: 32 - BAR_OVERLAP + BAR_EDGE, right: 400, bottom: 80 };
  assert.equal(placeHoverBar(exact, bar, bounds).side, "top");
  const oneLess = { ...exact, top: exact.top - 1 };
  assert.equal(placeHoverBar(oneLess, bar, bounds).side, "bottom");
});

test("placeHoverBar:上下都露不出来的高气泡,工具条贴可视区顶边压在气泡里", () => {
  const anchor = { left: 60, top: -200, right: 400, bottom: 900 };
  const p = placeHoverBar(anchor, bar, bounds);
  assert.equal(p.side, "pinned");
  assert.equal(anchor.top + p.y, bounds.top + BAR_EDGE);
});

test("gapBetween:相邻矩形的间隙;相交为 0", () => {
  assert.equal(gapBetween({ left: 0, top: 0, right: 10, bottom: 10 }, { left: 16, top: 0, right: 30, bottom: 10 }), 6);
  assert.equal(gapBetween({ left: 0, top: 0, right: 10, bottom: 10 }, { left: 5, top: 5, right: 30, bottom: 30 }), 0);
  assert.equal(gapBetween({ left: 0, top: 0, right: 10, bottom: 10 }, { left: 13, top: 14, right: 30, bottom: 30 }), 5);
});
