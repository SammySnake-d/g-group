import assert from "node:assert/strict";
import { after, test } from "node:test";
import { Host } from "./host.ts";
import { putDoc } from "./db.ts";
import { contactProfile } from "./views.ts";
import { scriptedMind } from "./fakes.ts";
import path from "node:path";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const root = mkdtempSync(path.join(tmpdir(), "gg-views-"));
after(() => rmSync(root, { recursive: true, force: true }));

test("contacts.profile: duties.doneTasks 收录 T8/T10/T11,排除在途任务,按最新更新时间倒序并最多 50 条", async () => {
  const dataDir = path.join(root, "case");
  mkdirSync(dataDir, { recursive: true });
  const host = new Host({ file: path.join(dataDir, "host.db"), dataDir, mind: () => scriptedMind() });
  try {
    const contact = host.createContact({ name: "小克" });
    const room = host.openDm(contact.id);
    const states = ["T8_Accepted", "T10_Cancelled", "T11_Failed"] as const;
    const done = states.flatMap((state, group) => Array.from({ length: 18 }, (_, i) => ({ state, i: group * 18 + i })));
    for (const item of done) {
      const task = host.createTask({ roomId: room.id, clientActionId: `done-${item.i}`, title: `done-${item.i}` });
      const doc = host.taskDoc(task.id);
      const createdAt = new Date(Date.UTC(2026, 0, 1, 0, item.i)).toISOString();
      const updatedAt = new Date(Date.UTC(2026, 0, 1, 1, item.i === 4 ? 54 : item.i)).toISOString();
      putDoc(host.db, `task:${task.id}`, doc.ver, { ...doc.value, task: { ...doc.value.task, owner: contact.id, state: item.state }, createdAt, updatedAt });
    }
    host.createTask({ roomId: room.id, clientActionId: "live", title: "live" });
    const profile = contactProfile(host, contact.id);
    assert.ok(profile.duties.doneTasks);
    assert.equal(profile.duties.doneTasks.length, 50);
    assert.equal(profile.duties.doneTasks.every((task) => states.includes(task.state as (typeof states)[number])), true);
    assert.equal(profile.duties.doneTasks.some((task) => task.title === "done-0"), false);
    assert.equal(profile.duties.doneTasks[0]!.title, "done-4");
    assert.equal(profile.duties.doneTasks[1]!.title, "done-53");
    assert.equal(profile.duties.doneTasks.at(-1)!.title, "done-5");
  } finally {
    await host.close();
  }
});

test("contacts.profile: 非代码仓与已合入 T8a_Delivered 归入 duties.doneTasks, 未合入代码仓 T8a_Delivered 保留在 duties.tasks", async () => {
  const dataDir = path.join(root, "delivered-case");
  mkdirSync(dataDir, { recursive: true });
  const host = new Host({ file: path.join(dataDir, "host.db"), dataDir, mind: () => scriptedMind() });
  try {
    const contact = host.createContact({ name: "小克" });
    const room = host.openDm(contact.id);
    const plain = host.createTask({ roomId: room.id, clientActionId: "plain", title: "plain-delivered" });
    const merged = host.createTask({ roomId: room.id, clientActionId: "merged", title: "merged-delivered" });
    const pinned = host.createTask({ roomId: room.id, clientActionId: "pinned", title: "pinned-delivered" });
    for (const [id, offset] of [[plain.id, 1], [merged.id, 2], [pinned.id, 3]] as const) {
      const doc = host.taskDoc(id);
      putDoc(host.db, `task:${id}`, doc.ver, { ...doc.value, task: { ...doc.value.task, owner: contact.id, state: "T8a_Delivered" }, updatedAt: new Date(Date.UTC(2026, 10, 21, 1, offset)).toISOString() });
    }
    putDoc(host.db, `ws:${merged.id}`, 0, { taskId: merged.id, dir: "/tmp/merged", branch: "gg/merged", targetBranch: "main", baseSha: "a", candidateSha: "b", state: "W6_Merged", targetHead: "b", verifiedOn: null, mergedSha: "b", conflict: null });
    putDoc(host.db, `ws:${pinned.id}`, 0, { taskId: pinned.id, dir: "/tmp/pinned", branch: "gg/pinned", targetBranch: "main", baseSha: "a", candidateSha: "b", state: "W3_Pinned", targetHead: null, verifiedOn: null, mergedSha: null, conflict: null });
    const profile = contactProfile(host, contact.id);
    assert.deepEqual(profile.duties.tasks.map((t) => t.id), [pinned.id]);
    assert.deepEqual(profile.duties.doneTasks?.map((t) => t.id), [merged.id, plain.id]);
  } finally {
    await host.close();
  }
});
