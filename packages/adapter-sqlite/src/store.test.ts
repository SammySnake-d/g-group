// SQLite 存储适配器行为测试:临时目录里的真实 sqlite 文件,不 mock。
// AC-05 落盘只追加、AC-21 两个连接的单一提交点、AC-31③ 入库端 action_id 去重(含真实崩溃重放)、重启持久。
import assert from "node:assert/strict";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, test } from "node:test";
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

// 真实多进程:每个子进程独立打开同一个库文件。父子之间只用 stdin/stdout 行协议做屏障(go / release),不靠睡眠定时;
// 子进程的每次等待都有上限,任何失败/超时路径都会杀掉并回收本测试起的全部子进程。
const CHILD = path.join(ROOT, "child.mjs");
fs.writeFileSync(CHILD, `
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
const [mod, file, key, value, cfgJson] = process.argv.slice(2);
const cfg = JSON.parse(cfgJson);
const say = (s) => fs.writeSync(1, s + "\\n");
const nap = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const buf = Buffer.alloc(64);
let pending = "";
const readLine = () => {
  for (;;) {
    const i = pending.indexOf("\\n");
    if (i >= 0) { const l = pending.slice(0, i); pending = pending.slice(i + 1); return l; }
    let n;
    try { n = fs.readSync(0, buf, 0, buf.length, null); } catch (e) { if (e.code === "EAGAIN") { nap(2); continue; } throw e; }
    if (n === 0) process.exit(70); // 父进程关了 stdin:不再等屏障
    pending += buf.toString("utf8", 0, n);
  }
};
if (cfg.exitBeforeReady) process.exit(42);
if (cfg.rawHold) {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("BEGIN IMMEDIATE");
  db.exec("CREATE TABLE IF NOT EXISTS hold (x)");
  say("held");
  if (readLine() !== "release") process.exit(71);
  db.exec("COMMIT");
  say("result " + JSON.stringify({ released: true }));
  process.exit(0);
}
const { openStore, commitDoc } = await import(mod);
if (cfg.openOnly) {
  say("opening");
  let out;
  try { openStore(file, { busyTimeoutMs: cfg.busyMs }); out = { opened: true }; } catch (e) { out = { threw: String(e.message) }; }
  say("result " + JSON.stringify(out));
  process.exit(0);
}
const s = openStore(file, { busyTimeoutMs: cfg.busyMs, onCasRead: () => { say("held"); if (cfg.holdUntilRelease && readLine() !== "release") process.exit(71); } });
say("ready");
if (readLine() !== "go") process.exit(72);
if (cfg.delayMs) nap(cfg.delayMs);
say("trying");
let out;
try { out = commitDoc(s, key, 0, value); } catch (e) { out = { threw: String(e.message) }; }
say("result " + JSON.stringify(out));
if (cfg.exitAfterResult) process.exit(42);
`);
const MOD = new URL("./index.ts", import.meta.url).href;
interface ChildCfg { busyMs?: number; holdUntilRelease?: boolean; delayMs?: number; exitBeforeReady?: boolean; exitAfterResult?: boolean; rawHold?: boolean; openOnly?: boolean }
interface Kid { pid: number; saw(line: string, ms?: number): Promise<void>; send(line: string): void; done(ms?: number): Promise<unknown> }
const live = new Set<ChildProcess>();
async function reap(): Promise<void> {
  await Promise.all([...live].map((c) => new Promise<void>((r) => {
    if (c.exitCode !== null || c.signalCode !== null) { live.delete(c); r(); return; }
    c.once("close", () => { live.delete(c); r(); });
    c.kill("SIGKILL");
  })));
}
afterEach(reap);
after(reap);
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
function kid(file: string, value: string, cfg: ChildCfg): Kid {
  const c = spawn(process.execPath, ["--no-warnings", CHILD, MOD, file, "主稿", value, JSON.stringify(cfg)], { stdio: ["pipe", "pipe", "pipe"] });
  live.add(c);
  let out = "", err = "", spawnError: Error | undefined, closed: { code: number | null; signal: string | null } | undefined;
  const wake = new Set<() => void>();
  const poke = () => { for (const w of [...wake]) w(); };
  c.on("error", (e) => { spawnError = e; poke(); });
  c.stdout!.setEncoding("utf8").on("data", (d: string) => { out += d; poke(); });
  c.stderr!.setEncoding("utf8").on("data", (d: string) => { err += d; });
  c.on("close", (code, signal) => { closed = { code, signal }; live.delete(c); poke(); });
  c.stdin!.on("error", () => {});
  const lines = () => out.split("\n");
  const until = <T>(what: string, ms: number, check: () => T | undefined): Promise<T> => new Promise((resolve, reject) => {
    const tick = () => {
      let v: T | undefined;
      try { v = check(); } catch (e) { finish(); reject(e); return; }
      if (v !== undefined) { finish(); resolve(v); }
    };
    const timer = setTimeout(() => { finish(); reject(new Error(`等待子进程 ${what} 超时 ${ms}ms;stdout=${JSON.stringify(out)} stderr=${err.slice(0, 400)}`)); }, ms);
    const finish = () => { clearTimeout(timer); wake.delete(tick); };
    wake.add(tick);
    tick();
  });
  const failed = () => {
    if (spawnError) throw new Error(`子进程启动失败:${spawnError.message}`);
    if (closed) throw new Error(`子进程提前退出 code=${closed.code} signal=${closed.signal};stdout=${JSON.stringify(out)} stderr=${err.slice(0, 400)}`);
  };
  return {
    pid: c.pid ?? -1,
    saw: (line, ms = 10_000) => until(`输出 ${line}`, ms, () => { if (lines().includes(line)) return true; failed(); return undefined; }).then(() => {}),
    send: (line) => { c.stdin!.write(`${line}\n`); },
    done: (ms = 20_000) => until("退出", ms, () => {
      if (spawnError) throw new Error(`子进程启动失败:${spawnError.message}`);
      if (!closed) return undefined;
      if (closed.code !== 0 || closed.signal !== null) throw new Error(`子进程异常退出 code=${closed.code} signal=${closed.signal};stdout=${JSON.stringify(out)} stderr=${err.slice(0, 400)}`);
      const m = /^result (.+)$/m.exec(out);
      if (!m) throw new Error(`子进程正常退出但没有输出结果;stdout=${JSON.stringify(out)}`);
      return JSON.parse(m[1]!) as unknown;
    }),
  };
}
const freshDb = () => { const f = prepare(dbFile()); closeStore(openStore(f)); return f; };

test("另一进程持有写锁时新连接照常打开:初始化等锁,不因提交用的 0 busy 超时失败", async () => {
  const f = prepare(dbFile());
  const holder = kid(f, "", { rawHold: true });
  await holder.saw("held");
  const opener = kid(f, "", { openOnly: true, busyMs: 0 });
  await opener.saw("opening");
  // 旧实现在这里立刻失败返回;等锁的实现在持锁方释放前不会有结果
  const early = await Promise.race([opener.done().then((r) => ({ early: r })), delay(400).then(() => undefined)]);
  holder.send("release");
  assert.deepEqual(await holder.done(), { released: true });
  assert.equal(early, undefined, JSON.stringify(early));
  assert.deepEqual(await opener.done(), { opened: true });
  const s = openStore(f, { busyTimeoutMs: 0 });
  assert.deepEqual(commitDoc(s, "主稿", 0, "打开后可写"), { ok: true, ver: 1 });
  closeStore(s);
});

test("两个独立进程基于同一版本同时提交:后到者等写锁,拿到锁后读到新版本收到冲突,内容是先到者的", async () => {
  const f = freshDb();
  const a = kid(f, "A 的修改", { busyMs: 10_000, holdUntilRelease: true });
  const b = kid(f, "B 的修改", { busyMs: 10_000, holdUntilRelease: true });
  await Promise.all([a.saw("ready"), b.saw("ready")]);
  a.send("go");
  b.send("go");
  await Promise.all([a.saw("trying"), b.saw("trying")]);
  // 两边都已真正发起提交;先拿到写锁的一方在读到版本后停住,另一方必须被挡在锁外
  const first = await Promise.any([a.saw("held").then(() => a), b.saw("held").then(() => b)]);
  const second = first === a ? b : a;
  first.send("release");
  const r1 = await first.done();
  await second.saw("held");
  second.send("release");
  const r2 = await second.done();
  assert.deepEqual(r1, { ok: true, ver: 1 });
  assert.deepEqual(r2, { ok: false, reason: "version-conflict", currentVer: 1 });
  const s = openStore(f);
  assert.deepEqual(readDoc(s, "主稿"), { value: first === a ? "A 的修改" : "B 的修改", ver: 1 });
  closeStore(s);
});

test("另一进程持有写锁期间提交返回 busy 且不写入;父进程确认后才释放,重试收到版本冲突", async () => {
  const f = freshDb();
  const a = kid(f, "A 的修改", { busyMs: 10_000, holdUntilRelease: true });
  const b = kid(f, "B 的修改", { busyMs: 0 });
  await Promise.all([a.saw("ready"), b.saw("ready")]);
  a.send("go");
  await a.saw("held");
  b.send("go");
  const rb = await b.done();
  a.send("release");
  const ra = await a.done();
  assert.deepEqual(rb, { ok: false, reason: "busy" });
  assert.deepEqual(ra, { ok: true, ver: 1 });
  const s = openStore(f);
  assert.deepEqual(readDoc(s, "主稿"), { value: "A 的修改", ver: 1 });
  assert.deepEqual(commitDoc(s, "主稿", 0, "B 的修改"), { ok: false, reason: "version-conflict", currentVer: 1 });
  closeStore(s);
});

test("提交遵守调用方的 busyTimeoutMs:持锁方一直不释放时,0 超时的提交在 2s 内返回 busy(初始化的长等待不能带进提交)", async () => {
  const f = freshDb();
  const a = kid(f, "A 的修改", { busyMs: 10_000, holdUntilRelease: true });
  const b = kid(f, "B 的修改", { busyMs: 0 });
  await Promise.all([a.saw("ready"), b.saw("ready")]);
  a.send("go");
  await a.saw("held");
  b.send("go");
  await b.saw("trying");
  const t0 = Date.now();
  const rb = await b.done(8000);
  const waited = Date.now() - t0;
  a.send("release");
  assert.deepEqual(await a.done(), { ok: true, ver: 1 });
  assert.deepEqual(rb, { ok: false, reason: "busy" });
  assert.ok(waited < 2000, `0 超时的提交等了 ${waited}ms`);
  const s = openStore(f);
  assert.deepEqual(readDoc(s, "主稿"), { value: "A 的修改", ver: 1 });
  closeStore(s);
});

test("调度延迟反例:B 放行后再拖 1500ms 才尝试,A 仍持锁,B 依旧返回 busy", async () => {
  const f = freshDb();
  const a = kid(f, "A 的修改", { busyMs: 10_000, holdUntilRelease: true });
  const b = kid(f, "B 的修改", { busyMs: 0, delayMs: 1500 });
  await Promise.all([a.saw("ready"), b.saw("ready")]);
  a.send("go");
  await a.saw("held");
  b.send("go");
  const rb = await b.done();
  a.send("release");
  assert.deepEqual(await a.done(), { ok: true, ver: 1 });
  assert.deepEqual(rb, { ok: false, reason: "busy" });
  const s = openStore(f);
  assert.deepEqual(readDoc(s, "主稿"), { value: "A 的修改", ver: 1 });
  closeStore(s);
});

test("测试夹具负例:子进程在就绪前退出,等待在有限时间内报失败,另一个等屏障的进程被回收,库未写入", async () => {
  const f = freshDb();
  const waiting = kid(f, "A 的修改", { busyMs: 10_000 });
  const broken = kid(f, "B 的修改", { exitBeforeReady: true });
  const t0 = Date.now();
  await assert.rejects(Promise.all([waiting.saw("ready"), broken.saw("ready")]), /提前退出 code=42/);
  assert.ok(Date.now() - t0 < 5000, `失败用了 ${Date.now() - t0}ms`);
  await reap();
  assert.equal(alive(waiting.pid) || alive(broken.pid), false);
  const s = openStore(f);
  assert.equal(readDoc(s, "主稿"), undefined);
  closeStore(s);
});

test("测试夹具负例:子进程输出结果后异常退出,done 判失败而不是拿结果当绿", async () => {
  const f = freshDb();
  const k = kid(f, "A 的修改", { busyMs: 10_000, exitAfterResult: true });
  await k.saw("ready");
  k.send("go");
  await k.saw("trying");
  await assert.rejects(k.done(), /异常退出 code=42/);
  assert.equal(alive(k.pid), false);
  const s = openStore(f);
  assert.deepEqual(readDoc(s, "主稿"), { value: "A 的修改", ver: 1 });
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
