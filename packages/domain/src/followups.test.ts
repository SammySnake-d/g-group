// 补充关联边与单条改挂:AC-15(E5b 改挂补充,含 A02、V24-01-R)、AC-16(收到 ≠ 落实)、AC-45 ②③(中途改条件原位升版、结果体现新条件)。
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type FollowUps,
  activeRequirements,
  amendWithFollowUp,
  applyArtifact,
  confirmRollbackStopped,
  emptyFollowUps,
  rebindFollowUp,
  rebindIn,
  rebindOut,
  receiveFollowUp,
  unappliedFollowUps,
} from "./followups.ts";
import { type Outcome, type Task, apply, applyAll, newTask } from "./task.ts";

const must = <T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> => {
  if (!r.ok) throw new Error((r as unknown as { reason: string }).reason);
  return r as Extract<T, { ok: true }>;
};
const mustT = (r: Outcome) => {
  if (!r.ok) throw new Error(r.reason);
  return r.task;
};
const running = (id: string, cp: string): Task =>
  mustT(applyAll(newTask(id, "u1"), [{ kind: "Claim", by: "argon" }, { kind: "Dispatch", computeId: cp, model: "claude-opus-5-5", requestId: `${id}#L0` }]));
const recv = (fu: FollowUps, seq: number, text: string, ver: number) => must(receiveFollowUp(fu, { roomId: "g", seq, text, ver })).value;

test("AC-16 送达只记 Received:登记补充后不是 Applied,也没有产物指针", () => {
  const fu = recv(emptyFollowUps("A"), 5, "把压缩换页补进去", 1);
  assert.equal(fu.links.length, 1);
  assert.equal(fu.links[0]!.state, "Received");
  assert.equal(fu.links[0]!.appliedIn, null);
  assert.deepEqual(unappliedFollowUps(fu).map((r) => r.seq), [5]);
});

test("AC-16 Applied 必须指向含该要求的产物版本:只有产物版本覆盖到的补充才标 Applied,更新的仍是 Received", () => {
  let fu = recv(emptyFollowUps("A"), 5, "补压缩换页", 1);
  fu = recv(fu, 7, "再加一节缓存", 2);
  const r = must(applyArtifact(fu, { artifact: "result:cp-1#r1", artifactVer: 1 }));
  assert.equal(r.value.links[0]!.state, "Applied");
  assert.equal(r.value.links[0]!.appliedIn, "result:cp-1#r1");
  assert.equal(r.value.links[0]!.appliedVer, 1);
  assert.equal(r.value.links[1]!.state, "Received");
  assert.deepEqual(r.pending?.map((x) => x.seq), [7]);
  assert.deepEqual(unappliedFollowUps(r.value).map((x) => x.seq), [7]);
});

test("AC-16 没有产物引用就不能标落实:空产物或非法版本被拒,状态不变", () => {
  const fu = recv(emptyFollowUps("A"), 5, "补压缩换页", 1);
  assert.equal(applyArtifact(fu, { artifact: "  ", artifactVer: 1 }).ok, false);
  assert.equal(applyArtifact(fu, { artifact: "r", artifactVer: -1 }).ok, false);
  assert.equal(fu.links[0]!.state, "Received");
});

test("AC-16 伪造的状态不当依据:标 Applied 却没有产物版本、未落实却带产物、Rebound 指向自己都被拒", () => {
  const base = recv(emptyFollowUps("A"), 5, "x", 1);
  const forge = (patch: object): FollowUps => ({ ...base, links: [{ ...base.links[0]!, ...patch }] }) as FollowUps;
  assert.match((applyArtifact(forge({ state: "Applied" }), { artifact: "r", artifactVer: 1 }) as { reason: string }).reason, /没有产物版本/);
  assert.match((receiveFollowUp(forge({ appliedIn: "r", appliedVer: 1 }), { roomId: "g", seq: 6, text: "y", ver: 1 }) as { reason: string }).reason, /未落实却带产物/);
  assert.match((receiveFollowUp(forge({ state: "Rebound", reboundTo: "A" }), { roomId: "g", seq: 6, text: "y", ver: 1 }) as { reason: string }).reason, /去向不合法/);
  const proxied = new Proxy(base, {});
  assert.equal(receiveFollowUp(proxied, { roomId: "g", seq: 6, text: "y", ver: 1 }).ok, false);
});

test("AC-16 登记幂等且版本不倒退:同一条重复送达不重复登记,比已登记更旧的版本被拒", () => {
  const fu = recv(emptyFollowUps("A"), 5, "x", 3);
  assert.equal(recv(fu, 5, "x", 3).links.length, 1);
  const r = receiveFollowUp(fu, { roomId: "g", seq: 6, text: "y", ver: 2 });
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, /倒退/);
});

// ---------------------------------------------------------------- AC-15 E5b
const sides = () => {
  let a = running("A", "cp-A");
  let fuA = emptyFollowUps("A");
  // #m(误挂)和 #n(合法补充)先后挂到 A,各推进一次版本
  const am = must(amendWithFollowUp({ task: a, followUps: fuA }, { roomId: "g", seq: 10, text: "测试报告加覆盖率表", by: "u1", computeResumable: true }));
  const an = must(amendWithFollowUp({ task: am.task, followUps: am.followUps }, { roomId: "g", seq: 12, text: "需求文档补压缩换页", by: "u1", computeResumable: true }));
  a = an.task;
  fuA = an.followUps;
  return { a: { task: a, followUps: fuA }, b: { task: running("B", "cp-B"), followUps: emptyFollowUps("B") } };
};

test("AC-15 改挂不取消 A:消息 m 从 A 移到 B,A 仍在执行,B 收下 消息 m", () => {
  const { a, b } = sides();
  const r = must(rebindFollowUp(a, b, { roomId: "g", seq: 10, expectedBindingVer: 0, by: "u1", computeResumable: true }));
  assert.equal(r.from.task.state, "T3_Running");
  assert.ok(!r.from.taskEffects.some((e) => e.kind === "stop-compute"), "改挂不能停掉 A 的执行器");
  assert.equal(r.from.followUps.links.find((l) => l.seq === 10)!.state, "Rebound");
  assert.equal(r.from.followUps.links.find((l) => l.seq === 10)!.reboundTo, "B");
  assert.equal(r.to.followUps.links.find((l) => l.seq === 10)!.state, "Received");
  assert.equal(r.to.followUps.links[0]!.ver, r.to.task.constraintVer);
});

test("AC-15 A 产生单调递增的新版本 v_A_new = 当前版本 + 1,旧版本的迟到回包不再生效", () => {
  const { a, b } = sides();
  const before = a.task.constraintVer;
  const r = must(rebindFollowUp(a, b, { roomId: "g", seq: 10, expectedBindingVer: 0, by: "u1", computeResumable: true }));
  assert.equal(r.from.task.constraintVer, before + 1);
  assert.ok(r.from.task.constraintVer > Math.max(...a.followUps.links.map((l) => l.ver)));
  // 版本没有回到 #m 之前的旧值:按旧版本提审的产物被幂等忽略,A 仍在执行
  const late = apply(r.from.task, { kind: "SubmitForReview", commit: "old", computeId: "cp-A", constraintVer: before });
  assert.ok(late.ok);
  assert.equal(late.task.state, "T3_Running");
  const lateOlder = apply(r.from.task, { kind: "SubmitForReview", commit: "older", computeId: "cp-A", constraintVer: 0 });
  assert.equal(lateOlder.ok && lateOlder.task.state, "T3_Running");
});

test("AC-15 完整保留并重放 消息 m 之后仍合法的补充 消息 n:A 的重放清单含 消息 n 不含 消息 m", () => {
  const { a, b } = sides();
  const r = must(rebindFollowUp(a, b, { roomId: "g", seq: 10, expectedBindingVer: 0, by: "u1", computeResumable: true }));
  const replay = r.from.effects.find((e) => e.kind === "replay");
  assert.ok(replay && replay.kind === "replay");
  assert.deepEqual(replay.requirements.map((x) => x.seq), [12]);
  assert.equal(replay.ver, r.from.task.constraintVer);
  assert.equal(r.from.followUps.links.find((l) => l.seq === 12)!.state, "Received");
  assert.deepEqual(activeRequirements(r.from.followUps).map((x) => x.text), ["需求文档补压缩换页"]);
  // A 的执行器收到新约束(同一实例续接),不是新开任务
  assert.ok(r.from.taskEffects.some((e) => e.kind === "update-constraints" && e.computeId === "cp-A"));
  const toReplay = r.to.effects.find((e) => e.kind === "replay");
  assert.ok(toReplay && toReplay.kind === "replay" && toReplay.requirements.some((x) => x.seq === 10));
});

test("AC-15 重复改挂幂等:同一条再改挂到 B,两边版本和关联都不再变化", () => {
  const { a, b } = sides();
  const r1 = must(rebindFollowUp(a, b, { roomId: "g", seq: 10, expectedBindingVer: 0, by: "u1", computeResumable: true }));
  const r2 = must(rebindFollowUp(r1.from, r1.to, { roomId: "g", seq: 10, expectedBindingVer: 0, by: "u1", computeResumable: true }));
  assert.equal(r2.idempotent, true);
  assert.equal(r2.from.task.constraintVer, r1.from.task.constraintVer);
  assert.equal(r2.to.task.constraintVer, r1.to.task.constraintVer);
  assert.equal(r2.from.followUps.bindingVer, r1.from.followUps.bindingVer);
  assert.equal(r2.to.followUps.links.length, 1);
  assert.equal(r2.from.effects.length + r2.to.effects.length + r2.from.taskEffects.length, 0);
});

test("AC-15 关联版本对不上按冲突拒绝,两边任务都不动", () => {
  const { a, b } = sides();
  const r = rebindFollowUp(a, b, { roomId: "g", seq: 10, expectedBindingVer: 7, by: "u1", computeResumable: true });
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, /关联版本已变/);
  const bad = rebindFollowUp(a, b, { roomId: "g", seq: 99, expectedBindingVer: 0, by: "u1", computeResumable: true });
  assert.match((bad as { reason: string }).reason, /不在任务 A 上/);
});

test("AC-15 改挂到已结束的任务被拒;已取消的 A 上误挂的 消息 m 可以移走、A 不复活", () => {
  const { a, b } = sides();
  const bDone = { task: mustT(applyAll(newTask("B", "u1"), [{ kind: "Cancel", by: "u1" }])), followUps: emptyFollowUps("B") };
  assert.match((rebindFollowUp(a, bDone, { roomId: "g", seq: 10, expectedBindingVer: 0, by: "u1", computeResumable: true }) as { reason: string }).reason, /已结束/);
  const aCancelled = { task: mustT(applyAll(newTask("A", "u1"), [{ kind: "Cancel", by: "u1" }])), followUps: recv(emptyFollowUps("A"), 10, "误挂", 0) };
  const r = must(rebindFollowUp(aCancelled, b, { roomId: "g", seq: 10, expectedBindingVer: 0, by: "u1", computeResumable: true }));
  assert.equal(r.from.task.state, "T10_Cancelled");
  assert.equal(r.from.effects.length, 0);
  assert.equal(r.to.followUps.links[0]!.state, "Received");
});

test("AC-15 消息 m 已落实进工作区:先发停止旧执行器,确认停止后才恢复 消息 m 之前的工作区并重放 消息 n", () => {
  const { a, b } = sides();
  const applied = must(applyArtifact(a.followUps, { artifact: "result:cp-A#r1", artifactVer: a.task.constraintVer })).value;
  const r = must(rebindFollowUp({ task: a.task, followUps: applied }, b, { roomId: "g", seq: 10, expectedBindingVer: 0, by: "u1", computeResumable: true }));
  assert.deepEqual(r.from.effects.map((e) => e.kind), ["stop-for-rollback"]);
  assert.ok(!r.from.effects.some((e) => e.kind === "restore-workspace"), "旧执行器没停稳之前不能回滚工作区");
  assert.equal(r.from.followUps.pendingRollback?.beforeSeq, 10);
  // #n 在 #m 之后落实过,随回滚失效,退回 Received 按新版本重做
  assert.equal(r.from.followUps.links.find((l) => l.seq === 12)!.state, "Received");
  assert.equal(r.from.followUps.links.find((l) => l.seq === 12)!.ver, r.from.task.constraintVer);
  // 等回滚期间产物不算落实
  assert.equal(applyArtifact(r.from.followUps, { artifact: "x", artifactVer: 99 }).ok, false);
  // 别的实例的停止确认不算数
  assert.equal(must(confirmRollbackStopped(r.from.followUps, "cp-other")).effects.length, 0);
  const c = must(confirmRollbackStopped(r.from.followUps, "cp-A"));
  assert.equal(c.effects.length, 1);
  const e = c.effects[0]!;
  assert.ok(e.kind === "restore-workspace");
  assert.equal(e.beforeSeq, 10);
  assert.deepEqual(e.requirements.map((x) => x.seq), [12]);
  assert.equal(c.value.pendingRollback, null);
});

test("AC-15 消息 m 已落实但没有在跑的执行器:直接恢复工作区并重放,不用等停止", () => {
  const fu = must(applyArtifact(recv(recv(emptyFollowUps("A"), 10, "m", 1), 12, "n", 2), { artifact: "r", artifactVer: 2 })).value;
  const r = must(rebindOut(fu, { roomId: "g", seq: 10, toTaskId: "B", expectedBindingVer: 0 }, 3, null));
  assert.deepEqual(r.effects.map((e) => e.kind), ["restore-workspace"]);
});

test("AC-15 改挂的新版本必须比已登记的都新(严禁复用旧版本号);已改挂别处的不能再挂到第三个任务", () => {
  const fu = recv(recv(emptyFollowUps("A"), 10, "m", 1), 12, "n", 2);
  assert.match((rebindOut(fu, { roomId: "g", seq: 10, toTaskId: "B", expectedBindingVer: 0 }, 2, "cp") as { reason: string }).reason, /单调递增/);
  const moved = must(rebindOut(fu, { roomId: "g", seq: 10, toTaskId: "B", expectedBindingVer: 0 }, 3, "cp")).value;
  assert.match((rebindOut(moved, { roomId: "g", seq: 10, toTaskId: "C", expectedBindingVer: 1 }, 4, "cp") as { reason: string }).reason, /已改挂到 B/);
  assert.match((receiveFollowUp(moved, { roomId: "g", seq: 10, text: "m", ver: 4 }) as { reason: string }).reason, /已改挂/);
});

test("AC-15 B→A 再挂回:目标任务上之前改挂走的那条重新激活为 Received", () => {
  const out = must(rebindOut(recv(emptyFollowUps("B"), 10, "m", 1), { roomId: "g", seq: 10, toTaskId: "A", expectedBindingVer: 0 }, 2, null)).value;
  const back = must(rebindIn(out, { roomId: "g", seq: 10, text: "m", fromTaskId: "A", ver: 3 }));
  assert.equal(back.value.links[0]!.state, "Received");
  assert.equal(back.value.links[0]!.reboundTo, null);
  assert.equal(back.value.bindingVer, 2);
});

// ---------------------------------------------------------------- AC-45
test("AC-45 ② 在途任务原位升版:T3(v1) → T3(v2),同一个执行器收到新约束,不新开任务", () => {
  const t = mustT(apply(running("A", "cp-A"), { kind: "Amend", by: "u1", computeResumable: true }));
  const r = must(amendWithFollowUp({ task: t, followUps: emptyFollowUps("A") }, { roomId: "g", seq: 20, text: "改成大阪,带老人", by: "u1", computeResumable: true }));
  assert.equal(t.constraintVer, 1);
  assert.equal(r.task.state, "T3_Running");
  assert.equal(r.task.id, "A");
  assert.equal(r.task.constraintVer, 2);
  assert.equal(r.task.computeId, "cp-A");
  assert.deepEqual(r.taskEffects, [{ kind: "update-constraints", computeId: "cp-A", constraintVer: 2 }]);
  assert.ok(!r.taskEffects.some((e) => e.kind === "spawn-compute"));
  assert.equal(r.followUps.links[0]!.ver, 2);
  // 同一条消息重复改条件幂等,不再升版
  const again = must(amendWithFollowUp({ task: r.task, followUps: r.followUps }, { roomId: "g", seq: 20, text: "改成大阪,带老人", by: "u1", computeResumable: true }));
  assert.equal(again.task.constraintVer, 2);
  assert.equal(again.taskEffects.length, 0);
});

test("AC-45 ② 审查中改条件:回到执行并续接原 Compute(可恢复时不新开实例)", () => {
  const inReview = mustT(apply(running("A", "cp-A"), { kind: "SubmitForReview", commit: "c1", computeId: "cp-A", constraintVer: 0 }));
  assert.equal(inReview.state, "T5_InReview");
  const r = must(amendWithFollowUp({ task: inReview, followUps: emptyFollowUps("A") }, { roomId: "g", seq: 21, text: "再加一个导出", by: "u1", computeResumable: true }));
  assert.equal(r.task.state, "T3_Running");
  assert.equal(r.task.computeId, "cp-A");
  assert.deepEqual(r.taskEffects, [{ kind: "resume-compute", computeId: "cp-A", constraintVer: 1 }]);
});

test("AC-45 ③ 新条件只送达未落实不算完成:v1 的产物不让 v2 的补充变成 Applied", () => {
  const r = must(amendWithFollowUp({ task: running("A", "cp-A"), followUps: emptyFollowUps("A") }, { roomId: "g", seq: 20, text: "改成大阪", by: "u1", computeResumable: true }));
  const old = must(applyArtifact(r.followUps, { artifact: "result:cp-A#r1", artifactVer: 0 }));
  assert.equal(old.value.links[0]!.state, "Received");
  assert.deepEqual(unappliedFollowUps(old.value).map((x) => x.seq), [20]);
  const fresh = must(applyArtifact(old.value, { artifact: "result:cp-A#r2", artifactVer: r.task.constraintVer }));
  assert.equal(fresh.value.links[0]!.state, "Applied");
  assert.equal(fresh.value.links[0]!.appliedIn, "result:cp-A#r2");
  assert.equal(unappliedFollowUps(fresh.value).length, 0);
});

test("AC-45 已结束的任务不能原位升版:新条件要另起任务", () => {
  const done = mustT(applyAll(newTask("A", "u1"), [{ kind: "Cancel", by: "u1" }]));
  const r = amendWithFollowUp({ task: done, followUps: emptyFollowUps("A") }, { roomId: "g", seq: 20, text: "x", by: "u1", computeResumable: true });
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, /已结束/);
});
