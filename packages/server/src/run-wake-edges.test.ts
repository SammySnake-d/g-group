// AC-36 ⑤ F11 休眠门第 1 轮返修(B-F11 审查 reviews/feat-run-wake-f11.md):
//   BF11-R1-01 宿主构造参数不合格时要在打开数据库之前拒绝——调用方拿不到 Host、也就没法 close(),失败构造不能留下文件和句柄;
//   BF11-R1-02 台账两处边界:宽限给 0 就是不宽限(不能被当成「没给」换成默认 3 分钟)。
// 句柄按进程实际打开的文件数:Linux 读 /proc/self/fd,macOS 用 lsof,只数这份测试自己的临时目录下的文件。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { HostError, openDb } from "./db.ts";
import { scriptedMind } from "./fakes.ts";
import { Host, type HostOptions } from "./host.ts";
import { RunStore, type RunStoreOptions } from "./runs.ts";

const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "gg-run-wake-edges-")));
after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
const SEC = 1000;
const MIN = 60_000;

/** 进程此刻打开着的、位于 under 目录下的文件数 */
function openFilesUnder(under: string): number {
  if (existsSync("/proc/self/fd")) {
    let n = 0;
    for (const fd of readdirSync("/proc/self/fd")) {
      try {
        if (readlinkSync(`/proc/self/fd/${fd}`).startsWith(`${under}/`)) n++;
      } catch {
        /* 读目录时用到的那个 fd 已关 */
      }
    }
    return n;
  }
  // 门禁沙箱里 PATH 只有 node 目录与 /usr/bin:/bin,macOS 的 lsof 在 /usr/sbin
  const lsof = existsSync("/usr/sbin/lsof") ? "/usr/sbin/lsof" : "lsof";
  const out = execFileSync(lsof, ["-nP", "-p", String(process.pid)], { encoding: "utf8" });
  return out.split("\n").filter((l) => l.includes(`${under}/`) && /^\d+[ruw]?$/.test(l.trim().split(/\s+/)[3] ?? "")).length;
}
/** 构造的结果:成功返回 ok(并关掉),HostError 返回「code:message」,其他错误原样转成字符串 */
async function construct(o: HostOptions): Promise<string> {
  let h: Host;
  try {
    h = new Host(o);
  } catch (e) {
    return e instanceof HostError ? `${e.code}:${e.message}` : `other:${String(e)}`;
  }
  await h.close();
  return "ok";
}
const mind = () => scriptedMind();

test("F11 宿主参数不合格在打开数据库之前就拒绝:休眠门参数、核对周期对不上、重试参数三种都不建文件、不改已有数据库、连续拒绝不留句柄;合法参数照常启动、关闭后不留句柄", async () => {
  const bad: [string, Partial<HostOptions>, string][] = [
    ["休眠门参数", { runWakePolicy: { jumpMs: 0 } }, "invalid_params:休眠门参数不合格:jumpMs 必须是正数、graceMs 必须是非负整数"],
    [
      "核对周期对不上",
      { runCheckMs: 40 * SEC, runWakePolicy: { jumpMs: 70 * SEC } },
      "invalid_params:休眠门参数不合格:jumpMs(70000 毫秒)不得小于核对周期的 2 倍(80000 毫秒),否则正常核对的间隔也会被当成休眠唤醒",
    ],
    ["重试参数", { retry: { maxAutoRetries: -1 } }, "invalid_params:重试参数不合格:maxAutoRetries 必须是非负整数"],
  ];
  // 新文件:拒绝三次,文件和旁路文件(-wal/-shm)都不出现,句柄始终 0
  for (const [what, o, msg] of bad) {
    const sub = path.join(dir, `new-${bad.findIndex((b) => b[0] === what)}`);
    mkdirSync(sub);
    const file = path.join(sub, "g.db");
    const got: string[] = [];
    const handles: number[] = [];
    for (let i = 0; i < 3; i++) {
      got.push(await construct({ file, mind, ...o }));
      handles.push(openFilesUnder(sub));
    }
    assert.deepEqual(got, [msg, msg, msg], `${what}:三次都按原因拒绝`);
    assert.deepEqual(readdirSync(sub), [], `${what}:拒绝时没建数据库文件`);
    assert.deepEqual(handles, [0, 0, 0], `${what}:连续拒绝不留打开的句柄`);
  }
  // 已有数据库:先用合法参数建好、写一条联系人、关掉;再用三种不合格参数各拒三次,文件逐字节不变、不多出文件、不留句柄
  const sub = path.join(dir, "existing");
  mkdirSync(sub);
  const file = path.join(sub, "g.db");
  const h = new Host({ file, mind });
  const c = h.createContact({ name: "小克" });
  assert.ok(openFilesUnder(sub) > 0, "句柄计数能看见宿主打开的数据库(对照)");
  await h.close();
  assert.equal(openFilesUnder(sub), 0, "合法宿主关闭后不留句柄");
  const bytes = readFileSync(file);
  const files = readdirSync(sub).sort();
  for (const [what, o, msg] of bad) {
    for (let i = 0; i < 3; i++) assert.equal(await construct({ file, mind, ...o }), msg, `${what}:已有数据库上同样拒绝`);
    assert.ok(readFileSync(file).equals(bytes), `${what}:已有数据库一个字节都没改`);
    assert.deepEqual(readdirSync(sub).sort(), files, `${what}:没多出文件`);
    assert.equal(openFilesUnder(sub), 0, `${what}:不留句柄`);
  }
  // 合法参数照常启动:读得回原来的联系人,关闭后不留句柄
  const again = new Host({ file, mind, runCheckMs: 40 * SEC, runWakePolicy: { jumpMs: 80 * SEC } });
  assert.deepEqual(
    again.listContacts().map((x) => x.id),
    [c.id],
  );
  await again.close();
  assert.equal(openFilesUnder(sub), 0);
});

/** 建台账:时钟与核对计时器都注入,由测试逐拍触发 */
function ledger(RS: typeof RunStore, o: Partial<RunStoreOptions>) {
  let t = 0;
  let ids = 0;
  const timers = new Map<number, () => void>();
  let handle = 0;
  const db = openDb(path.join(dir, `l${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}.db`));
  const store = new RS({
    db,
    bootId: "boot-1",
    clockMs: () => t,
    timers: {
      set: (fn) => {
        timers.set(++handle, fn);
        return handle;
      },
      clear: (x) => void timers.delete(x as number),
    },
    newId: (p) => `${p}-${++ids}`,
    thresholds: () => ({}),
    ...o,
  });
  return {
    store,
    at: (ms: number) => {
      t = ms;
    },
    beat: (ms: number) => {
      t = ms;
      const first = [...timers][0];
      assert.ok(first, `${ms / SEC} 秒时台账没有排着的核对`);
      timers.delete(first[0]);
      first[1]();
    },
    close: () => {
      store.stopTicker();
      db.close();
    },
  };
}
type L = ReturnType<typeof ledger>;
const judged = (l: L, id: string) =>
  l.store
    .events(id)
    .filter((e) => e.kind === "stall-judged")
    .map((e) => {
      const d = e.detail as { kind: string; judgedAt: string; thresholdMs: number };
      return `${d.kind}@${Date.parse(d.judgedAt) / SEC}s/${d.thresholdMs / SEC}s`;
    });

test("F11 宽限给 0 就是不宽限:合盖 10 分钟醒来后画板不显示休眠宽限,从醒来起算满 1 分钟无进展就判 stalled;同样合盖用默认宽限 3 分钟的对照这几拍都是休眠宽限、不判", () => {
  const run = (wake: RunStoreOptions["wake"]) => {
    const l = ledger(RunStore, { ...(wake ? { wake } : {}), thresholds: () => ({ defaults: { stallMs: MIN, firstByteMs: 20 * SEC } }) });
    l.store.startTicker();
    const u = l.store.start({ layer: "compute-turn", parentId: null, roomId: "r1", sourceSeq: 1, contactId: "c1", status: "running" });
    l.beat(30 * SEC);
    l.at(50 * SEC);
    l.store.activity(u.id, { kind: "progress", what: "output" });
    l.beat(60 * SEC);
    // 合盖 10 分钟:下一拍在 660 秒,之后每 30 秒一拍
    const waiting: (string | null)[] = [];
    for (const s of [660, 690]) {
      l.beat(s * SEC);
      waiting.push(l.store.liveCheck(l.store.get(u.id)!).waiting);
    }
    l.beat(720 * SEC);
    const r = { waiting, judged: judged(l, u.id), count: l.store.countEvents([u.id], "stall-judged", (d) => d.kind === "stalled") };
    l.close();
    return r;
  };
  assert.deepEqual(
    run({ jumpMs: 60 * SEC, graceMs: 0 }),
    { waiting: [null, null], judged: ["stalled@720s/60s"], count: 1 },
    "宽限 0:醒来后不显示休眠宽限,无进展从醒来(660 秒)起算,720 秒满 1 分钟判 stalled",
  );
  assert.deepEqual(run(undefined), { waiting: ["sleep_grace", "sleep_grace"], judged: [], count: 0 }, "默认宽限 3 分钟:同样几拍都是休眠宽限");
});
