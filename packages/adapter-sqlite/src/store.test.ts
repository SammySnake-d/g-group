// SQLite 存储适配器行为测试:临时目录里的真实 sqlite 文件,不 mock。
// AC-05 落盘只追加、AC-21 两个连接的单一提交点、AC-31③ 入库端 action_id 去重(含真实崩溃重放)、重启持久。
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { appendEvent, closeStore, commitDoc, listActions, loadLog, openStore, readDoc, recordAction } from "./index.ts";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "adapter-sqlite-"));
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));
let n = 0;
const dbFile = () => path.join(ROOT, `t${++n}`, "g.sqlite");
const prepare = (f: string) => { fs.mkdirSync(path.dirname(f), { recursive: true }); return f; };
const user = { kind: "user", id: "u1" };

test("追加的事件落盘后读回,hash 链完整、序号递增", () => {
  const s = openStore(prepare(dbFile()));
  const e1 = appendEvent(s, "g1", user, { kind: "message", text: "第一条" }, "2026-11-05T10:00:00Z");
  const e2 = appendEvent(s, "g1", user, { kind: "edit", target: 1, text: "第一条(改)" }, "2026-11-05T10:01:00Z");
  const loaded = loadLog(s, "g1");
  assert.deepEqual(loaded.check, { ok: true });
  assert.deepEqual(loaded.log.events.map((e) => [e.seq, e.hash]), [[1, e1.hash], [2, e2.hash]]);
  assert.equal(e2.prev, e1.hash);
  assert.deepEqual(loaded.log.events[1]?.body, { kind: "edit", target: 1, text: "第一条(改)" });
  closeStore(s);
});

test("不同会话各自成链,互不影响(阴性对照)", () => {
  const s = openStore(prepare(dbFile()));
  appendEvent(s, "g1", user, { kind: "message", text: "群一" }, "t1");
  const other = appendEvent(s, "g2", user, { kind: "message", text: "群二" }, "t2");
  assert.equal(other.seq, 1);
  assert.equal(loadLog(s, "g1").log.events.length, 1);
  assert.deepEqual(loadLog(s, "g2").check, { ok: true });
  closeStore(s);
});

test("直接用 SQL UPDATE 改旧事件被触发器拒绝,记录原样(阳性埋雷:删 UPDATE 触发器就能改)", () => {
  const s = openStore(prepare(dbFile()));
  appendEvent(s, "g1", user, { kind: "message", text: "原文" }, "t1");
  assert.throws(() => s.db.prepare("UPDATE events SET body = ? WHERE session = 'g1' AND seq = 1").run(JSON.stringify({ kind: "message", text: "改过" })), /append-only/);
  const loaded = loadLog(s, "g1");
  assert.deepEqual(loaded.log.events[0]?.body, { kind: "message", text: "原文" });
  assert.deepEqual(loaded.check, { ok: true });
  closeStore(s);
});

test("直接用 SQL DELETE 删旧事件被触发器拒绝(阳性埋雷:删 DELETE 触发器就能删)", () => {
  const s = openStore(prepare(dbFile()));
  appendEvent(s, "g1", user, { kind: "message", text: "原文" }, "t1");
  assert.throws(() => s.db.exec("DELETE FROM events WHERE session = 'g1'"), /append-only/);
  assert.equal(loadLog(s, "g1").log.events.length, 1);
  closeStore(s);
});

test("INSERT OR REPLACE 覆盖旧事件同样被拒绝(阳性埋雷:删覆盖触发器就能替换旧行)", () => {
  const s = openStore(prepare(dbFile()));
  const e = appendEvent(s, "g1", user, { kind: "message", text: "原文" }, "t1");
  assert.throws(() => s.db.prepare("INSERT OR REPLACE INTO events (session, seq, at, sender_kind, sender_id, body, prev, hash) VALUES ('g1', 1, ?, 'user', 'u1', ?, ?, ?)")
    .run(e.at, JSON.stringify({ kind: "message", text: "改过" }), e.prev, e.hash), /append-only/);
  assert.deepEqual(loadLog(s, "g1").log.events[0]?.body, { kind: "message", text: "原文" });
  closeStore(s);
});

test("绕过触发器篡改旧事件后,重新打开读回 verify 报出 brokenAt", () => {
  const f = prepare(dbFile());
  const s = openStore(f);
  appendEvent(s, "g1", user, { kind: "message", text: "原文" }, "t1");
  appendEvent(s, "g1", user, { kind: "message", text: "第二条" }, "t2");
  s.db.exec("DROP TRIGGER IF EXISTS events_no_update");
  s.db.prepare("UPDATE events SET body = ? WHERE session = 'g1' AND seq = 1").run(JSON.stringify({ kind: "message", text: "改过" }));
  closeStore(s);
  const r = openStore(f);
  const loaded = loadLog(r, "g1");
  assert.deepEqual(loaded.check, { ok: false, brokenAt: 1 });
  assert.equal(loaded.log.events.length, 2);
  closeStore(r);
});

test("落盘层仍执行领域约束:compute 发言被拒绝且不落盘", () => {
  const s = openStore(prepare(dbFile()));
  assert.throws(() => appendEvent(s, "g1", { kind: "compute", id: "cc" }, { kind: "message", text: "我来" }, "t1"), /sender-not-allowed/);
  assert.equal(loadLog(s, "g1").log.events.length, 0);
  closeStore(s);
});

test("文档 CAS:基于当前版本提交成功,基于旧版本提交收到冲突且不写入", () => {
  const s = openStore(prepare(dbFile()));
  assert.deepEqual(commitDoc(s, "主稿", 0, "v1"), { ok: true, ver: 1 });
  assert.deepEqual(commitDoc(s, "主稿", 1, "v2"), { ok: true, ver: 2 });
  assert.deepEqual(commitDoc(s, "主稿", 1, "旧版本上的修改"), { ok: false, reason: "version-conflict", currentVer: 2 });
  assert.deepEqual(readDoc(s, "主稿"), { value: "v2", ver: 2 });
  assert.equal(readDoc(s, "没有的文档"), undefined);
  closeStore(s);
});

test("文档 CAS:改不同文档都成功(阴性对照)", () => {
  const s = openStore(prepare(dbFile()));
  assert.deepEqual(commitDoc(s, "需求", 0, { v: "需求 1" }), { ok: true, ver: 1 });
  assert.deepEqual(commitDoc(s, "验收", 0, { v: "验收 1" }), { ok: true, ver: 1 });
  assert.deepEqual(readDoc(s, "需求"), { value: { v: "需求 1" }, ver: 1 });
  assert.deepEqual(readDoc(s, "验收"), { value: { v: "验收 1" }, ver: 1 });
  closeStore(s);
});

test("同进程两个连接:A 读到版本未写入时 B 提交,B 返回 busy 不写入,重试收到版本冲突", () => {
  const f = prepare(dbFile());
  const b = openStore(f, { busyTimeoutMs: 50 });
  const during: unknown[] = [];
  // A 读到版本、还没写入的那一刻,B 用同一版本提交:这是静默覆盖最容易发生的时刻
  const a = openStore(f, { busyTimeoutMs: 50, onCasRead: () => { during.push(commitDoc(b, "主稿", 0, "B 的修改")); } });
  assert.deepEqual(commitDoc(a, "主稿", 0, "A 的修改"), { ok: true, ver: 1 });
  assert.deepEqual(during, [{ ok: false, reason: "busy" }]);
  assert.deepEqual(commitDoc(b, "主稿", 0, "B 的修改"), { ok: false, reason: "version-conflict", currentVer: 1 });
  assert.deepEqual(readDoc(b, "主稿"), { value: "A 的修改", ver: 1 });
  closeStore(a);
  closeStore(b);
});

// 真实多进程:每个子进程独立打开同一个库文件,等屏障文件出现后才提交;读到版本后在事务里停 holdMs,把竞争窗口拉开
const CHILD = `
import fs from "node:fs";
import { openStore, commitDoc } from ${JSON.stringify(new URL("./index.ts", import.meta.url).href)};
const [file, key, value, busyMs, holdMs, go] = process.argv.slice(2);
const nap = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const s = openStore(file, { busyTimeoutMs: Number(busyMs), onCasRead: () => { process.stdout.write("held\\n"); nap(Number(holdMs)); } });
process.stdout.write("ready\\n");
while (!fs.existsSync(go)) nap(5);
let out;
try { out = commitDoc(s, key, 0, value); } catch (e) { out = { threw: String(e.message) }; }
process.stdout.write("result " + JSON.stringify(out) + "\\n");
`;
interface Proc { saw(line: string): Promise<void>; done: Promise<unknown> }
function proc(file: string, value: string, busyMs: number, holdMs: number, go: string): Proc {
  const script = path.join(path.dirname(file), "child.mjs");
  if (!fs.existsSync(script)) fs.writeFileSync(script, CHILD);
  const c = spawn(process.execPath, ["--no-warnings", script, file, "主稿", value, String(busyMs), String(holdMs), go], { stdio: ["ignore", "pipe", "inherit"] });
  let out = "";
  const waiters: [string, () => void][] = [];
  c.stdout.setEncoding("utf8").on("data", (d: string) => { out += d; for (const [l, r] of waiters) if (out.includes(`${l}\n`)) r(); });
  return {
    saw: (l) => new Promise((r) => { if (out.includes(`${l}\n`)) r(); else waiters.push([l, r]); }),
    done: new Promise((r) => c.on("close", () => { const m = /^result (.+)$/m.exec(out); r(m ? JSON.parse(m[1]!) : { exit: out }); })),
  };
}

test("两个独立进程基于同一版本同时提交:只有一个成功,另一个收到版本冲突,内容是胜者的", async () => {
  const f = prepare(dbFile());
  closeStore(openStore(f));
  const go = path.join(path.dirname(f), "go");
  const a = proc(f, "A 的修改", 5000, 300, go);
  const b = proc(f, "B 的修改", 5000, 300, go);
  await Promise.all([a.saw("ready"), b.saw("ready")]);
  fs.writeFileSync(go, "");
  const results = (await Promise.all([a.done, b.done])) as { ok: boolean; ver?: number; reason?: string; currentVer?: number }[];
  const wins = results.filter((r) => r.ok);
  assert.deepEqual(wins, [{ ok: true, ver: 1 }], JSON.stringify(results));
  assert.deepEqual(results.filter((r) => !r.ok), [{ ok: false, reason: "version-conflict", currentVer: 1 }], JSON.stringify(results));
  const s = openStore(f);
  const winner = results[0]?.ok ? "A 的修改" : "B 的修改";
  assert.deepEqual(readDoc(s, "主稿"), { value: winner, ver: 1 });
  closeStore(s);
});

test("另一进程持有写锁时提交返回 busy 且不写入;锁释放后按同一旧版本重试收到版本冲突", async () => {
  const f = prepare(dbFile());
  closeStore(openStore(f));
  const goA = path.join(path.dirname(f), "goA");
  const goB = path.join(path.dirname(f), "goB");
  const a = proc(f, "A 的修改", 5000, 600, goA);
  const b = proc(f, "B 的修改", 0, 0, goB);
  await Promise.all([a.saw("ready"), b.saw("ready")]);
  fs.writeFileSync(goA, "");
  await a.saw("held");
  fs.writeFileSync(goB, "");
  const [ra, rb] = await Promise.all([a.done, b.done]);
  assert.deepEqual(rb, { ok: false, reason: "busy" });
  assert.deepEqual(ra, { ok: true, ver: 1 });
  const s = openStore(f);
  assert.deepEqual(readDoc(s, "主稿"), { value: "A 的修改", ver: 1 });
  assert.deepEqual(commitDoc(s, "主稿", 0, "B 的修改"), { ok: false, reason: "version-conflict", currentVer: 1 });
  closeStore(s);
});

test("版本冲突不改任何文档:冲突的文档和旁边的文档内容、版本都不变", () => {
  const s = openStore(prepare(dbFile()));
  commitDoc(s, "需求", 0, "需求 v1");
  commitDoc(s, "验收", 0, "验收 v1");
  commitDoc(s, "验收", 1, "验收 v2");
  assert.deepEqual(commitDoc(s, "需求", 0, "旧版本上的修改"), { ok: false, reason: "version-conflict", currentVer: 1 });
  assert.deepEqual(readDoc(s, "需求"), { value: "需求 v1", ver: 1 });
  assert.deepEqual(readDoc(s, "验收"), { value: "验收 v2", ver: 2 });
  closeStore(s);
});

test("外发动作同一 action_id 重放只保留 1 行并返回已存在,原 payload 不被覆盖", () => {
  const s = openStore(prepare(dbFile()));
  assert.deepEqual(recordAction(s, "act_1", { text: "进度汇报" }), { recorded: true });
  assert.deepEqual(recordAction(s, "act_1", { text: "重放的汇报" }), { recorded: false, reason: "already-exists" });
  assert.deepEqual(listActions(s), [{ actionId: "act_1", payload: { text: "进度汇报" } }]);
  assert.equal((s.db.prepare("SELECT count(*) AS c FROM actions WHERE action_id = 'act_1'").get() as { c: number }).c, 1);
  closeStore(s);
});

test("不同 action_id 都写入(阴性对照)", () => {
  const s = openStore(prepare(dbFile()));
  assert.deepEqual(recordAction(s, "act_1", { text: "A 的汇报" }), { recorded: true });
  assert.deepEqual(recordAction(s, "act_2", { text: "B 的汇报" }), { recorded: true });
  assert.deepEqual(listActions(s).map((x) => x.actionId), ["act_1", "act_2"]);
  closeStore(s);
});

test("入库后、发送方记成功前进程被杀,重启重放同一 action_id 仍只有 1 条(AC-31③)", () => {
  const f = prepare(dbFile());
  const mod = new URL("./index.ts", import.meta.url).href;
  const child = spawnSync(process.execPath, ["--no-warnings", "--input-type=module", "-e",
    `import { openStore, recordAction } from ${JSON.stringify(mod)};
     const s = openStore(${JSON.stringify(f)});
     const r = recordAction(s, "act_1", { text: "T_A 进度汇报" });
     if (!r.recorded) process.exit(3);
     process.kill(process.pid, "SIGKILL");`], { encoding: "utf8" });
  assert.equal(child.signal, "SIGKILL", child.stderr);
  const s = openStore(f);
  assert.deepEqual(recordAction(s, "act_1", { text: "T_A 进度汇报" }), { recorded: false, reason: "already-exists" });
  assert.deepEqual(listActions(s), [{ actionId: "act_1", payload: { text: "T_A 进度汇报" } }]);
  closeStore(s);
});

test("重放已有 action_id 不改其他动作:旁边的动作仍在、payload 不变", () => {
  const s = openStore(prepare(dbFile()));
  recordAction(s, "act_1", { text: "A 的汇报" });
  recordAction(s, "act_2", { text: "B 的汇报" });
  assert.deepEqual(recordAction(s, "act_1", { text: "重放" }), { recorded: false, reason: "already-exists" });
  assert.deepEqual(listActions(s), [{ actionId: "act_1", payload: { text: "A 的汇报" } }, { actionId: "act_2", payload: { text: "B 的汇报" } }]);
  closeStore(s);
});

test("编辑和撤回都作为新事件落盘:关闭重开后三条都在,原消息逐字不变,链完整", () => {
  const f = prepare(dbFile());
  const s = openStore(f);
  const m = appendEvent(s, "g1", user, { kind: "message", text: "原文" }, "t1");
  const ed = appendEvent(s, "g1", user, { kind: "edit", target: 1, text: "改后" }, "t2");
  const rt = appendEvent(s, "g1", user, { kind: "retract", target: 1 }, "t3");
  closeStore(s);
  const r = openStore(f);
  const loaded = loadLog(r, "g1");
  assert.deepEqual(loaded.check, { ok: true });
  assert.deepEqual(loaded.log.events.map((e) => [e.seq, e.hash, e.prev]), [[1, m.hash, m.prev], [2, ed.hash, m.hash], [3, rt.hash, ed.hash]]);
  assert.deepEqual(loaded.log.events.map((e) => e.body), [{ kind: "message", text: "原文" }, { kind: "edit", target: 1, text: "改后" }, { kind: "retract", target: 1 }]);
  closeStore(r);
});

test("关闭再打开同一文件,事件、文档版本、动作都在", () => {
  const f = prepare(dbFile());
  const s = openStore(f);
  const e1 = appendEvent(s, "g1", user, { kind: "message", text: "持久" }, "t1");
  commitDoc(s, "主稿", 0, "v1");
  commitDoc(s, "主稿", 1, "v2");
  recordAction(s, "act_1", { text: "汇报" });
  closeStore(s);
  const r = openStore(f);
  const loaded = loadLog(r, "g1");
  assert.deepEqual(loaded.check, { ok: true });
  assert.deepEqual(loaded.log.events.map((e) => e.hash), [e1.hash]);
  const e2 = appendEvent(r, "g1", user, { kind: "message", text: "重启后续写" }, "t2");
  assert.equal(e2.prev, e1.hash);
  assert.deepEqual(readDoc(r, "主稿"), { value: "v2", ver: 2 });
  assert.deepEqual(commitDoc(r, "主稿", 1, "过期"), { ok: false, reason: "version-conflict", currentVer: 2 });
  assert.deepEqual(listActions(r), [{ actionId: "act_1", payload: { text: "汇报" } }]);
  closeStore(r);
});
