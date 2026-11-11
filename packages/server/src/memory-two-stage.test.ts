// G5 两段式记忆的宿主入口:真实 SQLite 与 md 文件、重开宿主;模型端是确定性的 reflect / refine 替身(不测模型效果)。
// 覆盖切换规则验收 ①～⑧ 与方案 G5-01～G5-04、审查 G5-a(精筛进 AC-43 background 单元、progress_get 可查、卡死判失败)、G5-b(与对话同一把联系人锁)。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test, type TestContext } from "node:test";
import type { CaptureMark, CompactMemory, MindAction, RefineRequest, RefineResult, ReflectRequest, ReflectResult, ReflectSource, RoundInput } from "@g-group/kernel";
import { listDocs } from "./db.ts";
import { Host, type HostOptions } from "./host.ts";
import type { CoverageWork } from "./memory-coverage.ts";

const root = mkdtempSync(path.join(tmpdir(), "gg-two-stage-"));
after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
let num = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(what: string, cond: () => boolean, ms = 4000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`等不到:${what}`);
    await sleep(5);
  }
}
const empty = (): ReflectResult => ({ note: null, memories: [], personaSuggestion: null });
type Refine = (r: RefineRequest, signal: AbortSignal) => Promise<RefineResult>;
type Mind = (i: RoundInput) => Promise<{ actions: MindAction[]; stateNote: string | null }>;
interface Opts {
  reflect?: (r: ReflectRequest) => Promise<ReflectResult>;
  refine?: Refine | null;
  mind?: Mind;
  host?: Partial<HostOptions>;
}
const fact = (s: ReflectSource, evidence: string, over: Partial<CompactMemory> = {}): CompactMemory => ({ title: evidence, text: evidence, anchors: [`room:${s.roomId}`], relation: null, target: null, roomId: s.roomId, sourceSeq: s.seq, evidence, kind: "fact", ...over });
/** 精筛替身:每个标记记成一条事实 */
const asFacts: Refine = async (r) => ({ memories: r.items.map((i) => fact(i.source, i.evidence)) });
/** 粗筛替身:用户原话里出现的这些短语各打一项标记 */
const marking = (...evidences: string[]) => async (r: ReflectRequest): Promise<ReflectResult> => ({
  ...empty(),
  marks: r.sources.flatMap((s) => evidences.filter((e) => s.senderKind === "user" && s.text.includes(e)).map((e): CaptureMark => ({ roomId: s.roomId, seq: s.seq, kind: "fact", evidence: e }))),
});
/** 一直不回、也不理会中止的精筛(上游收下请求后无响应) */
const silent: Refine = () => new Promise<RefineResult>(() => {});
/** 不回,但收到中止就退出 */
const waiting: Refine = (_r, signal) => new Promise<RefineResult>((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));

function boot(H: typeof Host, t: TestContext, dir: string, o: Opts) {
  const refines: RefineRequest[] = [];
  const rounds: RoundInput[] = [];
  const reflect = o.reflect ?? (async () => empty());
  const host = new H({
    file: path.join(dir, "db.sqlite"),
    dataDir: dir,
    maxDeferMs: 2,
    mind: () => ({ async round(i) { rounds.push(i); return o.mind ? o.mind(i) : { actions: [], stateNote: "MAIN" }; } }),
    compactor: () => ({
      async compact() { return "补写笔记"; },
      reflect,
      ...(o.refine === null ? {} : { async refine(r: RefineRequest, signal: AbortSignal) { refines.push(r); return (o.refine ?? asFacts)(r, signal); } }),
    }),
    retry: { baseDelayMs: 1, maxDelayMs: 5, jitter: 0 },
    fineScreen: { quietMs: 5 },
    ...o.host,
  });
  t.after(() => host.close());
  return { host, refines, rounds };
}
function setup(H: typeof Host, t: TestContext, o: Opts) {
  const dir = path.join(root, String(++num));
  mkdirSync(dir);
  const b = boot(H, t, dir, o);
  const c = b.host.createContact({ name: "查证", speakingModel: "fixture-model" });
  const dm = b.host.openDm(c.id);
  return { ...b, c, dm, dir };
}
async function idle(h: Host) {
  await until("宿主空闲", () => !h.loop.busy());
}
const works = (h: Host) => listDocs<CoverageWork>(h.db, "memory-coverage:").map((d) => d.value);
const fineRuns = (h: Host, contactId: string) => h.listRuns({ contactId }).runs.filter((r) => r.layer === "background");

test("G5-01EX 直接写与标记互斥 本人长期偏好写下即生效 其余只打标", async (t) => {
  const s = setup(Host, t, {
    refine: silent,
    host: { fineScreen: { quietMs: 60_000 } },
    reflect: async (r) => {
      const src = r.sources.find((x) => x.text.includes("以后都用中文回复"));
      if (!src) return empty();
      return {
        ...empty(),
        memories: [fact(src, "以后都用中文回复", { title: "语言", text: "用中文回复", anchors: ["global"], kind: "preference" }), fact(src, "缓存方案定为 Redis", { kind: "decision" })],
        marks: [{ roomId: src.roomId, seq: src.seq, kind: "preference", evidence: "以后都用中文回复" }],
      };
    },
  });
  s.host.send({ roomId: s.dm.id, clientActionId: "one", text: "以后都用中文回复。缓存方案定为 Redis" });
  await idle(s.host);
  assert.deepEqual(s.host.listMemories(s.c.id).map((m) => m.body), ["用中文回复"], "长期偏好当轮写下,决定不先写");
  assert.deepEqual(s.host.memoryMarks.list(s.c.id).map((m) => [m.kind, m.evidence]), [["decision", "缓存方案定为 Redis"]], "已直接写的那一项不再同时打标");
  assert.equal(s.host.memoryMarks.generation(s.c.id), 2);
  assert.ok(works(s.host).some((w) => w.state === "ok" && w.marks === 1));
});

test("G5-02RM 联系人主动记住当轮生效 不等待精筛", async (t) => {
  const s = setup(Host, t, {
    refine: silent,
    reflect: marking("发布前跑全量测试"),
    mind: async (i) => {
      const m = i.fresh.find((x) => x.kind === "message" && x.sender.kind === "user");
      return { actions: m?.kind === "message" ? [{ kind: "remember", roomId: m.roomId, sourceSeq: m.seq, title: "发布", text: "发布前跑全量测试", anchors: [`room:${m.roomId}`], quote: "发布前跑全量测试", relation: null, target: null }] : [], stateNote: "MAIN" };
    },
  });
  s.host.send({ roomId: s.dm.id, clientActionId: "one", text: "记住:发布前跑全量测试" });
  await until("精筛已发出且挂着", () => s.refines.length === 1);
  assert.deepEqual(s.host.listMemories(s.c.id).map((m) => [m.body, m.status]), [["发布前跑全量测试", "active"]], "精筛还挂着,主动记住已生效");
  assert.equal(s.host.memoryMarks.open(s.c.id).length, 1, "标记仍是欠账");
});

test("G5-02S4 精筛遇到本轮已主动记住的内容按复述处理不新增", async (t) => {
  const s = setup(Host, t, {
    reflect: marking("发布前跑全量测试"),
    mind: async (i) => {
      const m = i.fresh.find((x) => x.kind === "message" && x.sender.kind === "user");
      return { actions: m?.kind === "message" ? [{ kind: "remember", roomId: m.roomId, sourceSeq: m.seq, title: "发布", text: "发布前跑全量测试", anchors: [`room:${m.roomId}`], quote: "发布前跑全量测试", relation: null, target: null }] : [], stateNote: "MAIN" };
    },
  });
  s.host.send({ roomId: s.dm.id, clientActionId: "one", text: "记住:发布前跑全量测试" });
  await until("精筛完成", () => s.host.memoryMarks.list(s.c.id).some((m) => m.state === "done"));
  const list = s.host.listMemories(s.c.id);
  assert.equal(list.length, 1, "不新增第二条");
  assert.equal(list[0]!.body, "发布前跑全量测试");
  assert.equal(list[0]!.evidence.length, 1, "复述只多一条佐证");
  assert.equal(s.refines.length, 1);
});

test("G5-03SW G1已写md未确认跨切换 不重复写也不再打标", async (t) => {
  const dir = path.join(root, String(++num));
  mkdirSync(dir);
  const MSG = "缓存方案定为 Redis";
  const reflect = async (r: ReflectRequest): Promise<ReflectResult> => {
    const src = r.sources.find((x) => x.text === MSG);
    return src ? { ...empty(), memories: [fact(src, MSG), { ...fact(src, MSG), roomId: "nope" }] } : empty();
  };
  const g1 = boot(Host, t, dir, { refine: null, reflect });
  const c = g1.host.createContact({ name: "查证", speakingModel: "fixture-model" });
  const dm = g1.host.openDm(c.id);
  const memory = Reflect.get(g1.host, "memory") as { put: (c: string, e: unknown) => void };
  const put = memory.put.bind(memory);
  memory.put = (cid, e) => { put(cid, e); throw new Error("after-md-before-index-commit"); };
  g1.host.send({ roomId: dm.id, clientActionId: "one", text: MSG });
  await idle(g1.host);
  assert.ok(works(g1.host).some((w) => w.writes !== null && !w.writesDone), "G1 留下了 md 已写、库未确认的提交");
  await g1.host.close();
  const g5 = boot(Host, t, dir, { reflect, host: { fineScreen: { quietMs: 60_000 } } });
  const recovered = g5.host.listMemories(c.id).map((m) => [m.id, m.version, m.evidence.length]);
  assert.equal(recovered.length, 1);
  g5.host.send({ roomId: dm.id, clientActionId: "two", text: "再聊一件事" });
  await idle(g5.host);
  assert.equal(g5.host.memoryMarks.generation(c.id), 2);
  const legacy = works(g5.host).find((w) => w.sources.some((x) => x.seq === 1))!;
  assert.equal(legacy.takeover, true);
  assert.equal(legacy.handedOver, true, "接管项已由第 2 代出口处理");
  assert.deepEqual(g5.host.listMemories(c.id).map((m) => [m.id, m.version, m.evidence.length]), recovered, "不新增条目、佐证或版本");
  assert.equal(g5.host.memoryMarks.list(c.id).filter((m) => m.evidence === MSG).length, 0, "G1 已落地的候选不再生成标记");
  assert.equal(g5.refines.length, 0);
});

test("G5-04OW 移交事务前后退出 重启后同一候选只有一个可执行 owner", async (t) => {
  const dir = path.join(root, String(++num));
  mkdirSync(dir);
  const MSG = "缓存方案定为 Redis";
  let failing = true;
  const reflect = async (r: ReflectRequest): Promise<ReflectResult> => {
    const src = r.sources.find((x) => x.text === MSG);
    if (!src) return empty();
    if (failing) throw new Error("upstream 503");
    return { ...empty(), marks: [{ roomId: src.roomId, seq: src.seq, kind: "decision", evidence: MSG }] };
  };
  const quiet = { fineScreen: { quietMs: 60_000 }, retry: { baseDelayMs: 1, maxDelayMs: 2, jitter: 0, maxAutoRetries: 20 } };
  const g1 = boot(Host, t, dir, { refine: null, reflect, host: quiet });
  const c = g1.host.createContact({ name: "查证", speakingModel: "fixture-model" });
  const dm = g1.host.openDm(c.id);
  g1.host.send({ roomId: dm.id, clientActionId: "one", text: MSG });
  await idle(g1.host);
  const legacyId = works(g1.host).find((w) => w.state === "failed")!.id;
  await g1.host.close();
  const legacyOf = (h: Host) => works(h).find((w) => w.id === legacyId)!;
  const owners = (h: Host) => {
    const w = legacyOf(h);
    const marks = h.memoryMarks.list(c.id).filter((m) => m.origin.coverageId === w.id && m.state === "pending");
    const workOwns = w.state !== "ok" && !w.disposition;
    return { workOwns, marks: marks.length };
  };
  // 第一次:切换事务里退出(还没落盘),仍是第 1 代,G1 欠账原样
  const a = boot(Host, t, dir, { reflect, host: quiet });
  a.host.memoryMarks.switchTx = () => { throw new Error("exit-inside-switch"); };
  await sleep(5);
  a.host.send({ roomId: dm.id, clientActionId: "two", text: "第二条" });
  await idle(a.host);
  assert.equal(a.host.memoryMarks.generation(c.id), 1);
  assert.deepEqual(owners(a.host), { workOwns: true, marks: 0 });
  assert.equal(legacyOf(a.host).takeover, undefined);
  await a.host.close();
  // 第二次:切换已落盘,出口事务(标记 + 覆盖结果)中途退出:标记一起回滚,仍只有覆盖欠账这一个 owner
  failing = false;
  const b = boot(Host, t, dir, { reflect, host: quiet });
  const prepare = b.host.memoryCoverage.prepare.bind(b.host.memoryCoverage);
  let thrown = 0;
  b.host.memoryCoverage.prepare = (id, writes, unresolved) => {
    if (id === legacyOf(b.host).id && thrown++ === 0) throw new Error("upstream 503 exit-after-marks");
    prepare(id, writes, unresolved);
  };
  await sleep(5);
  b.host.send({ roomId: dm.id, clientActionId: "three", text: "第三条" });
  await idle(b.host);
  assert.equal(thrown, 1, "夹具确实在出口事务里退出");
  assert.equal(b.host.memoryMarks.generation(c.id), 2);
  assert.equal(legacyOf(b.host).takeover, true);
  assert.deepEqual(owners(b.host), { workOwns: true, marks: 0 }, "不能同时留下旧欠账和新标记");
  await b.host.close();
  // 第三次:正常完成移交;再重启也只剩标记这一个 owner
  const d = boot(Host, t, dir, { reflect, host: quiet });
  await sleep(5);
  d.host.send({ roomId: dm.id, clientActionId: "four", text: "第四条" });
  await idle(d.host);
  assert.deepEqual(owners(d.host), { workOwns: false, marks: 1 });
  const m = d.host.memoryMarks.list(c.id).find((x) => x.evidence === MSG)!;
  assert.equal(m.origin.takeover, true, "接管来的标记保留原覆盖身份");
  assert.equal(legacyOf(d.host).handedOver, true);
  await d.host.close();
  const e = boot(Host, t, dir, { reflect, host: quiet });
  await sleep(5);
  e.host.send({ roomId: dm.id, clientActionId: "five", text: "第五条" });
  await idle(e.host);
  assert.deepEqual(owners(e.host), { workOwns: false, marks: 1 });
});

test("G5-05TW 一条消息两项候选都保留并各自精筛落地", async (t) => {
  const s = setup(Host, t, { reflect: marking("缓存方案定为 Redis", "发布定在周五") });
  s.host.send({ roomId: s.dm.id, clientActionId: "one", text: "缓存方案定为 Redis,发布定在周五" });
  await until("两项都精筛完", () => s.host.memoryMarks.list(s.c.id).filter((m) => m.state === "done").length === 2);
  assert.deepEqual(s.host.memoryMarks.list(s.c.id).map((m) => m.seq), [1, 1], "同一 seq 两项");
  assert.deepEqual(s.refines.flatMap((r) => r.items.map((i) => i.evidence)).sort(), ["发布定在周五", "缓存方案定为 Redis"]);
  assert.deepEqual(s.host.listMemories(s.c.id).map((m) => m.body).sort(), ["发布定在周五", "缓存方案定为 Redis"]);
});

test("G5-06ED 编辑后的待办不回灌旧文 新版本另开检查工作项", async (t) => {
  const s = setup(Host, t, { reflect: marking("缓存方案定为 Redis"), host: { fineScreen: { quietMs: 150 } } });
  const sent = s.host.send({ roomId: s.dm.id, clientActionId: "one", text: "缓存方案定为 Redis" });
  await until("打了标记", () => s.host.memoryMarks.list(s.c.id).length === 1);
  s.host.editMessage(s.dm.id, sent.seq, "缓存方案改成 Memcached");
  await until("旧标记已处置", () => s.host.memoryMarks.list(s.c.id).some((m) => m.state === "disposed"));
  await idle(s.host);
  const m = s.host.memoryMarks.list(s.c.id)[0]!;
  assert.deepEqual([m.state, m.evidence, m.disposition], ["disposed", null, "source-edited"]);
  assert.equal(s.refines.some((r) => JSON.stringify(r).includes("Redis")), false, "旧原话没进精筛请求");
  const next = works(s.host).find((w) => w.id === m.next);
  assert.ok(next, "新版本有自己的检查工作项");
  assert.ok(next.sources.every((x) => x.seq === sent.seq && x.revision > m.revision));
  assert.equal(s.host.listMemories(s.c.id).length, 0);
});

test("G5-06RT 撤回后的待办只留无正文处置", async (t) => {
  const s = setup(Host, t, { reflect: marking("NEUTRAL_RETRACTED_DECISION"), host: { fineScreen: { quietMs: 150 } } });
  const sent = s.host.send({ roomId: s.dm.id, clientActionId: "one", text: "NEUTRAL_RETRACTED_DECISION" });
  await until("打了标记", () => s.host.memoryMarks.list(s.c.id).length === 1);
  s.host.retractMessage(s.dm.id, sent.seq);
  await until("标记已处置", () => s.host.memoryMarks.list(s.c.id).some((m) => m.state === "disposed"));
  await idle(s.host);
  const m = s.host.memoryMarks.list(s.c.id)[0]!;
  assert.deepEqual([m.state, m.evidence, m.disposition, m.next], ["disposed", null, "source-retracted-or-inaccessible", null]);
  assert.equal(JSON.stringify(s.host.memoryMarks.list(s.c.id)).includes("NEUTRAL_RETRACTED_DECISION"), false, "处置记录里没有原文");
  assert.equal(s.refines.length, 0);
});

test("G5-07LK 精筛与对话不并发 都在同一把联系人锁里", async (t) => {
  let overlap = 0;
  const s: ReturnType<typeof setup> = setup(Host, t, {
    refine: waiting,
    reflect: marking("缓存方案定为 Redis"),
    mind: async () => {
      if (fineRuns(s.host, s.c.id).some((r) => r.status === "running")) overlap++;
      return { actions: [], stateNote: "MAIN" };
    },
  });
  s.host.send({ roomId: s.dm.id, clientActionId: "one", text: "缓存方案定为 Redis" });
  await until("精筛在跑", () => s.refines.length === 1);
  s.host.send({ roomId: s.dm.id, clientActionId: "two", text: "另一件事" });
  await until("第二轮对话跑完", () => s.rounds.length === 2);
  await until("精筛再次发出", () => s.refines.length === 2);
  assert.equal(overlap, 0, "对话轮跑的时候没有精筛单元在跑");
  assert.equal(fineRuns(s.host, s.c.id)[0]!.status, "interrupted", "先跑的精筛让出后才轮到对话");
});

test("G5-07PE 有新消息精筛让出联系人锁 标记保留为欠账", async (t) => {
  const s = setup(Host, t, { refine: waiting, reflect: marking("缓存方案定为 Redis") });
  s.host.send({ roomId: s.dm.id, clientActionId: "one", text: "缓存方案定为 Redis" });
  await until("精筛在跑", () => s.refines.length === 1);
  s.host.send({ roomId: s.dm.id, clientActionId: "two", text: "另一件事" });
  await until("对话没被精筛挡住", () => s.rounds.length === 2, 1500);
  const first = fineRuns(s.host, s.c.id)[0]!;
  assert.equal(first.status, "interrupted");
  const m = s.host.memoryMarks.list(s.c.id)[0]!;
  assert.deepEqual([m.state, m.attempts, m.evidence], ["pending", 0, "缓存方案定为 Redis"], "让出不算失败,也不清债");
});

test("G5-07PG 精筛进行中 progress_get 能查到后台单元", async (t) => {
  let release!: (r: RefineResult) => void;
  const s = setup(Host, t, { refine: () => new Promise<RefineResult>((r) => { release = r; }), reflect: marking("缓存方案定为 Redis") });
  s.host.send({ roomId: s.dm.id, clientActionId: "one", text: "缓存方案定为 Redis" });
  await until("精筛在跑", () => s.refines.length === 1);
  const unit = fineRuns(s.host, s.c.id)[0]!;
  const got = s.host.getRun(unit.id);
  assert.deepEqual([got.run.layer, got.run.status, got.run.contactId, got.run.roomId], ["background", "running", s.c.id, s.dm.id]);
  assert.ok(got.events.some((e) => e.kind === "fine-screen"));
  release({ memories: [] });
  await until("精筛结束", () => s.host.getRun(unit.id).run.status === "done");
  assert.equal(s.host.memoryMarks.list(s.c.id)[0]!.state, "done", "空结果是有效的「没有值得记的」");
});

test("G5-07ST 精筛无进展超过阈值判失败 标记留作欠账", async (t) => {
  const s = setup(Host, t, { refine: silent, reflect: marking("缓存方案定为 Redis"), host: { runCheckMs: 10, runThresholds: { defaults: { stallMs: 80, firstByteMs: 80 } } } });
  s.host.send({ roomId: s.dm.id, clientActionId: "one", text: "缓存方案定为 Redis" });
  await until("精筛单元判失败", () => fineRuns(s.host, s.c.id).some((r) => r.status === "failed"));
  const failed = fineRuns(s.host, s.c.id).find((r) => r.status === "failed")!;
  assert.equal(failed.reasonClass, "no_response");
  assert.ok(failed.thresholdMs === 80);
  await until("标记记下卡住", () => s.host.memoryMarks.list(s.c.id)[0]!.attempts >= 1);
  const m = s.host.memoryMarks.list(s.c.id)[0]!;
  assert.equal(m.state, "pending");
  assert.match(m.error ?? "", /卡住/);
});

test("G5-08FL 精筛一直失败不清债也不退回直接写", async (t) => {
  const s = setup(Host, t, { refine: async () => { throw new Error("upstream 503"); }, reflect: marking("以后回复先给结论"), host: { retry: { baseDelayMs: 1, maxDelayMs: 2, jitter: 0, maxAutoRetries: 2 } } });
  s.host.send({ roomId: s.dm.id, clientActionId: "one", text: "以后回复先给结论" });
  await until("重试到上限", () => s.host.memoryMarks.list(s.c.id)[0]?.blocked === true);
  await idle(s.host);
  assert.equal(s.refines.length, 3, "首发 + 2 次自动重试");
  const m = s.host.memoryMarks.list(s.c.id)[0]!;
  assert.deepEqual([m.state, m.evidence], ["pending", "以后回复先给结论"], "到上限仍是欠账");
  assert.match(m.error ?? "", /503/);
  assert.equal(s.host.listMemories(s.c.id).length, 0, "不退回粗筛直接写");
  assert.equal(s.host.memoryMarks.open(s.c.id).length, 1);
});

test("G5-01IN 两个联系人同群各记各的标记与覆盖", async (t) => {
  const s = setup(Host, t, { reflect: marking("缓存方案定为 Redis"), host: { fineScreen: { quietMs: 60_000 } } });
  const other = s.host.createContact({ name: "复核", speakingModel: "fixture-model" });
  const g = s.host.createGroup("项目群", [{ kind: "contact", id: s.c.id }, { kind: "contact", id: other.id }]);
  s.host.send({ roomId: g.id, clientActionId: "one", text: "缓存方案定为 Redis", mentions: [{ id: s.c.id, source: "manual" }, { id: other.id, source: "manual" }] });
  await until("两位都打了标记", () => s.host.memoryMarks.list(s.c.id).length === 1 && s.host.memoryMarks.list(other.id).length === 1);
  const a = s.host.memoryMarks.list(s.c.id)[0]!;
  const b = s.host.memoryMarks.list(other.id)[0]!;
  assert.deepEqual([a.contactId, b.contactId], [s.c.id, other.id]);
  assert.notEqual(a.origin.coverageId, b.origin.coverageId, "覆盖按联系人分开");
  assert.equal(works(s.host).filter((w) => w.sources.some((x) => x.roomId === g.id)).length, 2);
});

test("G5-03RU 精筛卡住时当轮回复与规矩照常提交", async (t) => {
  const s = setup(Host, t, {
    refine: silent,
    reflect: marking("缓存方案定为 Redis"),
    mind: async (i) => {
      const m = i.fresh.find((x) => x.kind === "message" && x.text.includes("先跑全量"));
      return { actions: m?.kind === "message" ? [{ kind: "reply", roomId: m.roomId, text: "收到,以后发版前先跑全量", replyToSeq: m.seq }] : [], stateNote: "MAIN" };
    },
  });
  s.host.send({ roomId: s.dm.id, clientActionId: "one", text: "缓存方案定为 Redis" });
  await until("精筛卡着", () => s.refines.length === 1);
  s.host.send({ roomId: s.dm.id, clientActionId: "two", text: "以后发版前先跑全量" });
  await until("当轮回复已提交", () => s.host.listMessages(s.dm.id, {}).messages.some((m) => m.text === "收到,以后发版前先跑全量"), 2000);
  assert.equal(s.host.memoryMarks.open(s.c.id).length, 1, "标记还在等精筛");
});

test("G5-04BT 精筛一批至多 8 个标记 余下的下一批", async (t) => {
  const stems = ["甲", "乙", "丙", "丁", "戊", "己", "庚", "辛", "壬", "癸"].map((x) => `${x}事项定了`);
  const s = setup(Host, t, { reflect: marking(...stems) });
  s.host.send({ roomId: s.dm.id, clientActionId: "one", text: stems.join(",") });
  await until("十项都精筛完", () => s.host.memoryMarks.list(s.c.id).filter((m) => m.state === "done").length === 10);
  assert.deepEqual(s.refines.map((r) => r.items.length), [8, 2]);
  assert.equal(s.host.listMemories(s.c.id).length, 10);
});

test("G5-04CL 关闭后不再发精筛 标记在重启后续做", async (t) => {
  const dir = path.join(root, String(++num));
  mkdirSync(dir);
  const reflect = marking("缓存方案定为 Redis");
  const first = boot(Host, t, dir, { refine: silent, reflect });
  const c = first.host.createContact({ name: "查证", speakingModel: "fixture-model" });
  const dm = first.host.openDm(c.id);
  first.host.send({ roomId: dm.id, clientActionId: "one", text: "缓存方案定为 Redis" });
  await until("精筛在跑", () => first.refines.length === 1);
  await first.host.close();
  await sleep(40);
  assert.equal(first.refines.length, 1, "关闭后没有新的精筛调用");
  const second = boot(Host, t, dir, { reflect });
  await until("重启后续做完", () => second.host.memoryMarks.list(c.id)[0]?.state === "done");
  assert.equal(second.refines.length, 1);
  assert.deepEqual(second.host.listMemories(c.id).map((m) => m.body), ["缓存方案定为 Redis"]);
});

test("G5-02RS 重启不清待精筛标记", async (t) => {
  const dir = path.join(root, String(++num));
  mkdirSync(dir);
  const reflect = marking("缓存方案定为 Redis");
  const quiet = { fineScreen: { quietMs: 60_000 } };
  const first = boot(Host, t, dir, { reflect, host: quiet });
  const c = first.host.createContact({ name: "查证", speakingModel: "fixture-model" });
  const dm = first.host.openDm(c.id);
  first.host.send({ roomId: dm.id, clientActionId: "one", text: "缓存方案定为 Redis" });
  await until("打了标记", () => first.host.memoryMarks.list(c.id).length === 1);
  await idle(first.host);
  const before = first.host.memoryMarks.list(c.id)[0]!;
  await first.host.close();
  const second = boot(Host, t, dir, { reflect, host: quiet });
  await sleep(20);
  const after = second.host.memoryMarks.open(c.id);
  assert.deepEqual(after.map((m) => [m.id, m.state, m.evidence, m.attempts]), [[before.id, "pending", "缓存方案定为 Redis", 0]]);
  assert.equal(second.host.memoryMarks.generation(c.id), 2, "代次留在联系人上");
  assert.equal(second.refines.length, 0, "安静期没到不精筛");
});
