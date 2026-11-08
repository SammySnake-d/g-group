import assert from "node:assert/strict";
import { test } from "node:test";
import { BAR_GAP, gapBetween, placeHoverBar } from "./anchor.ts";

const bounds = { left: 0, top: 0, right: 900, bottom: 700 };
const bar = { width: 130, height: 32 };

test("placeHoverBar:别人的短消息,工具条在气泡右侧外沿、垂直居中", () => {
  const anchor = { left: 60, top: 200, right: 360, bottom: 240 };
  assert.deepEqual(placeHoverBar(anchor, bar, bounds, false), { x: 300 + BAR_GAP, y: 4, side: "after" });
});

test("placeHoverBar:自己的消息放左侧外沿,并让出已读回执的宽度", () => {
  const anchor = { left: 500, top: 100, right: 860, bottom: 138 };
  assert.deepEqual(placeHoverBar(anchor, bar, bounds, true, 28), { x: -130 - BAR_GAP - 28, y: 3, side: "before" });
});

test("placeHoverBar:高气泡对齐第一行,不随高度漂到中间或底部", () => {
  const anchor = { left: 60, top: 100, right: 500, bottom: 420 };
  const p = placeHoverBar(anchor, bar, bounds, false);
  assert.equal(p.side, "after");
  assert.equal(p.y, 2);
});

test("placeHoverBar:右边放不下就换到左边;两边都放不下就压在右上角", () => {
  const wide = { left: 60, top: 100, right: 840, bottom: 140 };
  const p1 = placeHoverBar(wide, bar, bounds, false);
  assert.equal(p1.side, "inside");
  assert.equal(p1.x, 780 - 130 - 8);
  assert.equal(p1.y, -16);
  const nearRight = { left: 400, top: 100, right: 840, bottom: 140 };
  assert.deepEqual(placeHoverBar(nearRight, bar, bounds, false), { x: -130 - BAR_GAP, y: 4, side: "before" });
  const mineNearLeft = { left: 20, top: 100, right: 300, bottom: 140 };
  assert.deepEqual(placeHoverBar(mineNearLeft, bar, bounds, true, 28), { x: 280 + BAR_GAP, y: 4, side: "after" });
});

test("placeHoverBar:气泡上半截滚出可视区时,工具条贴可视区顶边但不越过气泡底边", () => {
  const anchor = { left: 60, top: -200, right: 400, bottom: 300 };
  assert.equal(placeHoverBar(anchor, bar, bounds, false).y, 204);
  const almostGone = { left: 60, top: -200, right: 400, bottom: 10 };
  assert.equal(placeHoverBar(almostGone, bar, bounds, false).y, 210 - 32);
});

test("gapBetween:相邻矩形的间隙;相交为 0", () => {
  assert.equal(gapBetween({ left: 0, top: 0, right: 10, bottom: 10 }, { left: 16, top: 0, right: 30, bottom: 10 }), 6);
  assert.equal(gapBetween({ left: 0, top: 0, right: 10, bottom: 10 }, { left: 5, top: 5, right: 30, bottom: 30 }), 0);
  assert.equal(gapBetween({ left: 0, top: 0, right: 10, bottom: 10 }, { left: 13, top: 14, right: 30, bottom: 30 }), 5);
});
