// G1 复用联系人锁；同步到达的新通知也不能在 running 赋值前重入。
import assert from "node:assert/strict";
import { test } from "node:test";
import { createAttentionLoop } from "./attention.ts";
test("G1-LOCK 同步回调里的通知也保持同联系人单飞", async () => {
  let active=0,max=0,count=0;
  const loop=createAttentionLoop({maxDeferMs:1,run:async()=>{active++;max=Math.max(max,active);count++;if(count===1)loop.notify("c","now");await Promise.resolve();active--;return "done";}});
  try {loop.notify("c","now");await loop.idle();assert.equal(max,1);assert.equal(count,2);assert.equal(loop.rounds("c"),2);}
  finally {await loop.stop();}
});
