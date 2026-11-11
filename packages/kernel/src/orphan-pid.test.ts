// 存活核对里进程判定的边界(需求文档 D26 第 3 节「按 pid、宿主启动号和心跳检查所有 running」,AC-43 ②):
// 只有还在跑的单元按执行进程判定;等人回答的单元进程可以不在(一次性进程停在受阻就退出,常驻进程空闲回收),
// 用户回答后按会话 id 续接,不能因为进程不在就把它判成没跑完。宿主侧的接线与端到端行为在 server 包的 runtime-config.test.ts。
import assert from "node:assert/strict";
import { test } from "node:test";
import { type RunUnit, newRun, reconcileOrphans, runDisplay, setStatus } from "./run-ledger.ts";

const T0 = Date.parse("2026-11-11T02:00:00Z");
const MIN = 60_000;
const base = { roomId: "g1", sourceSeq: 3, contactId: "c1", bootId: "boot-1", at: T0 };
const live = (pid: number) => (p: number) => p === pid;

/** 应用一次状态变化,把变化写回列表(测试里模拟宿主落盘) */
function apply(units: RunUnit[], id: string, to: RunUnit["status"], at: number, extra?: Parameters<typeof setStatus>[4]) {
  const r = setStatus(units, id, to, at, extra);
  if (!r.ok) throw new Error(`状态变化被拒:${r.reason}`);
  for (const c of r.changed) units.splice(units.findIndex((u) => u.id === c.id), 1, c);
}

test("等人回答的单元不按执行进程判定:受阻时进程已经不在(或常驻进程被回收)也不判 orphaned,回答后续接照常;还在跑的单元进程不在才判(AC-43 ②)", () => {
  const units: RunUnit[] = [
    newRun({ ...base, id: "s", layer: "compute-session", parentId: null, pid: 4242 }),
    newRun({ ...base, id: "t", layer: "compute-turn", parentId: "s", pid: 4242 }),
    newRun({ ...base, id: "run", layer: "compute-turn", parentId: null, pid: 4242 }),
    newRun({ ...base, id: "bg", layer: "background", parentId: "run" }),
  ];
  apply(units, "t", "waiting_user", T0 + 1);
  apply(units, "s", "waiting_user", T0 + 1);
  const gone = reconcileOrphans(units, { bootId: "boot-1", at: T0 + MIN, alive: () => false });
  assert.deepEqual(
    gone.map((u) => [u.id, u.status, u.note]),
    [
      ["run", "orphaned", "执行进程已不在"],
      ["bg", "orphaned", "父单元已结束(orphaned)"],
    ],
    "等人回答的会话与轮次不动,只有还在跑的单元按进程判",
  );
  assert.deepEqual(
    units.filter((u) => u.id === "t" || u.id === "s").map((u) => [u.id, u.status, u.pid]),
    [
      ["s", "waiting_user", 4242],
      ["t", "waiting_user", 4242],
    ],
  );
  // 进程活着:还在跑的单元照常不被判;没报 pid 的单元也不按进程判
  const live2: RunUnit[] = [newRun({ ...base, id: "r2", layer: "compute-turn", parentId: null, pid: 7 }), newRun({ ...base, id: "nopid", layer: "compute-turn", parentId: null })];
  assert.deepEqual(reconcileOrphans(live2, { bootId: "boot-1", at: T0 + MIN, alive: live(7) }), []);
  // 画板文字:还在跑的单元照常写「运行中 · 已跑 N」,进程不在之后同一份台账改成「没跑完 · 执行进程已不在」
  const shown = newRun({ ...base, id: "shown", layer: "compute-turn", parentId: null, pid: 4242 });
  assert.equal(runDisplay(shown, T0 + 30_000).text, "运行中 · 已跑 30 秒");
  const after = reconcileOrphans([shown], { bootId: "boot-1", at: T0 + 31_000, alive: () => false })[0]!;
  assert.deepEqual([runDisplay(after, T0 + 31_000).tone, runDisplay(after, T0 + 31_000).text], ["orphaned", "没跑完 · 执行进程已不在"]);
  // 宿主启动号不同(上一次启动留下的):不管是不是等人回答,一律成孤儿「宿主进程退出」
  const cross: RunUnit[] = [newRun({ ...base, id: "w", layer: "compute-turn", parentId: null, pid: 9 }), newRun({ ...base, id: "w2", layer: "compute-turn", parentId: null, pid: 9 })];
  apply(cross, "w2", "waiting_user", T0 + 1);
  assert.deepEqual(
    reconcileOrphans(cross, { bootId: "boot-2", at: T0 + MIN, alive: () => true }).map((u) => [u.id, u.note]),
    [
      ["w", "宿主进程退出"],
      ["w2", "宿主进程退出"],
    ],
  );
});
