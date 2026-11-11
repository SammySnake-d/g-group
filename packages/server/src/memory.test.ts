// 联系人记忆接进宿主(需求文档 D25;验收 AC-42 ①–⑩)。md 真源 + 可重建索引;写入判关系由宿主按模型给的关系落地;
// 读取按本轮锚点硬筛进第 5 块,全局条目进第 1 块前缀;会话中途的全局变化只追加在第 5 块,前缀不变;按 id 读全文走本轮工具。
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import type { MindAction, RoundInput, RoundTools } from "@g-group/kernel";
import { Host } from "./host.ts";

const dir = mkdtempSync(path.join(tmpdir(), "gg-mem-"));
after(() => rmSync(dir, { recursive: true, force: true }));
let no = 0;
const fresh = () => {
  const d = path.join(dir, `d${++no}`);
  mkdirSync(d, { recursive: true });
  return { file: path.join(d, "gg.db"), dataDir: d };
};
async function settle(host: Host) {
  for (let i = 0; i < 200; i++) {
    await host.idle();
    await new Promise((r) => setTimeout(r, 5));
    if (!host.loop.busy()) return;
  }
  throw new Error("宿主没有安静下来");
}
type Script = (i: RoundInput, tools: RoundTools | undefined) => Promise<MindAction[]> | MindAction[];
function scripted(script: Script, reqs: RoundInput["request"][] = []) {
  return () => ({
    async round(i: RoundInput, _s: AbortSignal, tools?: RoundTools) {
      reqs.push(i.request);
      return { actions: await script(i, tools), stateNote: null };
    },
  });
}
const lastMsg = (i: RoundInput) => {
  const m = [...i.fresh].reverse().find((f) => f.kind === "message");
  if (m?.kind !== "message") throw new Error("本轮没有消息");
  return m;
};
const remember = (i: RoundInput, over: Partial<Extract<MindAction, { kind: "remember" }>>): MindAction => {
  const m = lastMsg(i);
  return { kind: "remember", roomId: m.roomId, sourceSeq: m.seq, title: "审查交给谁", text: m.text, anchors: [`room:${m.roomId}`, "tool:review"], quote: m.text, relation: null, target: null, ...over };
};
const b = (r: RoundInput["request"], n: number) => r.blocks[n - 1]!.text;

test("写下就生效:remember 落成 md 文件(真源),下一轮锚点相交时就出现在第 5 块,中间没有候选或审核", async () => {
  const reqs: RoundInput["request"][] = [];
  const o = fresh();
  const host = new Host({ ...o, maxDeferMs: 5, mind: scripted((i) => (lastMsg(i).text.startsWith("记住") ? [remember(i, { text: "PR 审查交给 Astra", quote: null })] : []), reqs) });
  const c = host.createContact({ name: "小克" });
  const g = host.createGroup("g", [{ kind: "contact", id: c.id }]);
  host.send({ roomId: g.id, clientActionId: "1", text: "记住:PR 审查交给 Astra", mentions: [{ id: c.id, source: "manual" }] });
  await settle(host);
  const files = readdirSync(path.join(o.dataDir, "memory", c.id));
  assert.equal(files.length, 1);
  const md = readFileSync(path.join(o.dataDir, "memory", c.id, files[0]!), "utf8");
  assert.match(md, /"status": "active"/);
  assert.match(md, /PR 审查交给 Astra\n$/);
  host.send({ roomId: g.id, clientActionId: "2", text: "下周的审查安排一下", mentions: [{ id: c.id, source: "manual" }] });
  await settle(host);
  assert.match(b(reqs.at(-1)!, 5), /〔记忆 m-[^〕]+ · 审查交给谁〕\nPR 审查交给 Astra/);
  assert.doesNotMatch(b(reqs.at(-1)!, 1), /PR 审查交给 Astra/, "锚点型条目不进前缀");
  await host.close();
});

test("改变出新版本:审查交 Astra → 改交 Codex,之后的读取只取到 Codex;旧条目仍在(已替代),不删除", async () => {
  const reqs: RoundInput["request"][] = [];
  let astra = "";
  const host = new Host({
    ...fresh(), maxDeferMs: 5,
    mind: scripted((i) => {
      const t = lastMsg(i).text;
      if (t.includes("Astra")) return [remember(i, { text: "PR 审查交给 Astra" })];
      if (t.includes("Codex")) return [remember(i, { text: "PR 审查改交 Codex", relation: "change", target: astra })];
      return [];
    }, reqs),
  });
  const c = host.createContact({ name: "小克" });
  const dm = host.openDm(c.id);
  host.send({ roomId: dm.id, clientActionId: "1", text: "以后审查交给 Astra" });
  await settle(host);
  astra = host.listMemories(c.id)[0]!.id;
  host.send({ roomId: dm.id, clientActionId: "2", text: "审查改交 Codex 吧" });
  await settle(host);
  host.send({ roomId: dm.id, clientActionId: "3", text: "安排审查" });
  await settle(host);
  const last = reqs.at(-1)!.blocks.map((x) => x.text).join("");
  assert.match(last, /PR 审查改交 Codex/);
  assert.doesNotMatch(last, /PR 审查交给 Astra/, "已替代条目不进上下文");
  const all = host.listMemories(c.id);
  assert.deepEqual(all.map((m) => m.status).sort(), ["active", "superseded"]);
  assert.equal(all.find((m) => m.id === astra)!.supersededBy, all.find((m) => m.status === "active")!.id);
  await host.close();
});

test("复述不新增:同一内容再记一次,条目数不变,旧条目 evidence 加一", async () => {
  const host = new Host({ ...fresh(), maxDeferMs: 5, mind: scripted((i) => [remember(i, { text: "回复先给结论", quote: null, title: "回复风格", anchors: [`room:${lastMsg(i).roomId}`] })]) });
  const c = host.createContact({ name: "小克" });
  const dm = host.openDm(c.id);
  host.send({ roomId: dm.id, clientActionId: "1", text: "回复先给结论" });
  await settle(host);
  host.send({ roomId: dm.id, clientActionId: "2", text: "再说一次:回复先给结论" });
  await settle(host);
  const ms = host.listMemories(c.id);
  assert.equal(ms.length, 1);
  assert.equal(ms[0]!.evidence.length, 1);
  await host.close();
});

test("冲突且两边都是用户原话:不自动替代,两条都留着,联系人在会话里 @ 用户请拍板", async () => {
  let first = "";
  const host = new Host({
    ...fresh(), maxDeferMs: 5,
    mind: scripted((i) => {
      const t = lastMsg(i).text;
      if (t.includes("中文")) return [remember(i, { title: "回复语言", text: t, anchors: [`room:${lastMsg(i).roomId}`] })];
      return [remember(i, { title: "回复语言", text: t, anchors: [`room:${lastMsg(i).roomId}`], relation: "conflict", target: first })];
    }),
  });
  const c = host.createContact({ name: "小克" });
  const g = host.createGroup("g", [{ kind: "contact", id: c.id }]);
  host.send({ roomId: g.id, clientActionId: "1", text: "回复都用中文", mentions: [{ id: c.id, source: "manual" }] });
  await settle(host);
  first = host.listMemories(c.id)[0]!.id;
  host.send({ roomId: g.id, clientActionId: "2", text: "回复都用英文", mentions: [{ id: c.id, source: "manual" }] });
  await settle(host);
  const ms = host.listMemories(c.id);
  assert.deepEqual(ms.map((m) => m.status), ["active", "active"], "不自动替代");
  assert.deepEqual(ms.find((m) => m.id !== first)!.conflictsWith, [first]);
  const ask = host.listMessages(g.id, {}).messages.at(-1)!;
  assert.equal(ask.sender.kind, "contact");
  assert.match(ask.text, /冲突/);
  assert.ok(ask.mentions.some((x) => x.id === host.userId), "@ 用户");
  await host.close();
});

test("全局条目进第 1 块;会话中途新增全局条目只追加在第 5 块(前缀逐字节不变),积累到折叠阈值才并入前缀", async () => {
  const reqs: RoundInput["request"][] = [];
  const host = new Host({
    ...fresh(), maxDeferMs: 5, memoryFoldAfter: 2,
    mind: scripted((i) => (lastMsg(i).text.startsWith("以后") ? [remember(i, { title: lastMsg(i).text, text: lastMsg(i).text, anchors: ["global"] })] : []), reqs),
  });
  const c = host.createContact({ name: "小克" });
  const dm = host.openDm(c.id);
  host.send({ roomId: dm.id, clientActionId: "1", text: "你好" });
  await settle(host);
  const p0 = b(reqs[0]!, 1);
  host.send({ roomId: dm.id, clientActionId: "2", text: "以后所有回复都用中文" });
  await settle(host);
  host.send({ roomId: dm.id, clientActionId: "3", text: "在吗" });
  await settle(host);
  assert.equal(b(reqs[2]!, 1), p0, "中途变化不改前缀");
  assert.match(b(reqs[2]!, 5), /记忆变化[^\n]*\n[\s\S]*以后所有回复都用中文/);
  host.send({ roomId: dm.id, clientActionId: "4", text: "以后所有代码都要先写测试" });
  await settle(host);
  host.send({ roomId: dm.id, clientActionId: "5", text: "好" });
  await settle(host);
  const last = reqs.at(-1)!;
  assert.match(b(last, 1), /以后所有回复都用中文[\s\S]*以后所有代码都要先写测试/, "到阈值并入前缀");
  assert.doesNotMatch(b(last, 5), /记忆变化/);
  assert.deepEqual(host.listMemories(c.id).map((m) => [m.anchors, m.status]), [[["global"], "active"], [["global"], "active"]], "两条都按全局记下");
  await host.close();
});

test("作用域:没有「以后都/所有」这类原话的全局写入改挂到当前会话锚点,不进前缀", async () => {
  const reqs: RoundInput["request"][] = [];
  const host = new Host({ ...fresh(), maxDeferMs: 5, mind: scripted((i) => (lastMsg(i).text.includes("表格") ? [remember(i, { title: "格式", text: "不要用表格", anchors: ["global"] })] : []), reqs) });
  const c = host.createContact({ name: "小克" });
  const dm = host.openDm(c.id);
  host.send({ roomId: dm.id, clientActionId: "1", text: "这次不要用表格" });
  await settle(host);
  const [m] = host.listMemories(c.id);
  assert.deepEqual(m!.anchors, [`room:${dm.id}`]);
  host.send({ roomId: dm.id, clientActionId: "2", text: "继续" });
  await settle(host);
  assert.doesNotMatch(b(reqs.at(-1)!, 1), /不要用表格/);
  assert.match(b(reqs.at(-1)!, 5), /不要用表格/);
  await host.close();
});

test("原话校验:quote 不出自来源用户消息时整条拒收,不写记忆", async () => {
  const reports: string[] = [];
  const host = new Host({ ...fresh(), maxDeferMs: 5, onReport: (w) => reports.push(w), mind: scripted((i) => [remember(i, { quote: "用户从没说过的话" })]) });
  const c = host.createContact({ name: "小克" });
  const dm = host.openDm(c.id);
  host.send({ roomId: dm.id, clientActionId: "1", text: "审查交给 Astra" });
  await settle(host);
  assert.equal(host.listMemories(c.id).length, 0);
  assert.ok(reports.includes("action-rejected"));
  await host.close();
});

test("可重建:删掉索引后从 md 重建,读取结果与重建前一致", async () => {
  const reqs: RoundInput["request"][] = [];
  const o = fresh();
  let i0 = 0;
  const host = new Host({ ...o, maxDeferMs: 5, mind: scripted((i) => (++i0 <= 3 ? [remember(i, { title: `条目${i0}`, text: lastMsg(i).text, quote: null, anchors: [`room:${lastMsg(i).roomId}`] })] : []), reqs) });
  const c = host.createContact({ name: "小克" });
  const dm = host.openDm(c.id);
  for (const t of ["记一:先给结论", "记二:用中文", "记三:别用表格"]) {
    host.send({ roomId: dm.id, clientActionId: t, text: t });
    await settle(host);
  }
  host.send({ roomId: dm.id, clientActionId: "q1", text: "问" });
  await settle(host);
  const before = b(reqs.at(-1)!, 5);
  const n = host.rebuildMemoryIndex(c.id);
  assert.equal(n, 3);
  host.send({ roomId: dm.id, clientActionId: "q2", text: "问" });
  await settle(host);
  assert.equal(b(reqs.at(-1)!, 5).replace(/#\d+/g, ""), before.replace(/#\d+/g, ""));
  await host.close();
});

test("用后反馈:memory-use 连续三次结果不好就降级,条目仍在可查;read_memory 工具按 id 读全文,已替代的给出替代者", async () => {
  let id = "";
  const reads: (string | null)[] = [];
  const host = new Host({
    ...fresh(), maxDeferMs: 5,
    mind: scripted(async (i, tools) => {
      const t = lastMsg(i).text;
      if (t === "记") return [remember(i, { title: "部署", text: "部署前先跑测试", quote: null, anchors: [`room:${lastMsg(i).roomId}`] })];
      if (t === "读") { reads.push(await tools!.readMemory(id)); reads.push(await tools!.readMemory("m-不存在")); return []; }
      return [{ kind: "memory-use", id, good: false, note: "走错路" }];
    }),
  });
  const c = host.createContact({ name: "小克" });
  const dm = host.openDm(c.id);
  host.send({ roomId: dm.id, clientActionId: "0", text: "记" });
  await settle(host);
  id = host.listMemories(c.id)[0]!.id;
  for (const k of ["1", "2", "3"]) {
    host.send({ roomId: dm.id, clientActionId: k, text: `反馈${k}` });
    await settle(host);
  }
  const m = host.listMemories(c.id)[0]!;
  assert.equal(m.status, "degraded");
  assert.equal(m.uses.length, 3);
  host.send({ roomId: dm.id, clientActionId: "r", text: "读" });
  await settle(host);
  assert.match(reads[0] ?? "", /部署前先跑测试/);
  assert.match(reads[0] ?? "", /降级/);
  assert.equal(reads[1], null);
  assert.ok(existsSync(path.join(dir)));
  await host.close();
});

// ---------------------------------------------------------------- 压缩触发写记忆(用户 #1196,协调 #1250:各助手各压各的,压缩时由代码固定发起「有没有值得记的」)

type ReflectReq = Parameters<NonNullable<import("@g-group/kernel").ContactCompactor["reflect"]>>[0];
type ReflectOut = Awaited<ReturnType<NonNullable<import("@g-group/kernel").ContactCompactor["reflect"]>>>;

test("每轮结束宿主固定发起一次检查(不靠模型自己想起调 remember):用该联系人的说话模型与人设,带本轮材料与邻域记忆;返回的记忆点写进它自己的记忆,下一轮读回第 5 块", async () => {
  const reqs: RoundInput["request"][] = [];
  const asks: ReflectReq[] = [];
  let out: ReflectOut = { note: "笔记:用户定了部署规矩", memories: [{ title: "部署规矩", text: "部署前先跑测试", anchors: ["room:ROOM"], relation: null, target: null }], personaSuggestion: null };
  const host = new Host({
    ...fresh(), maxDeferMs: 5,
    mind: scripted(() => [], reqs),
    compactor: () => ({ async compact() { throw new Error("有 reflect 时不该再调 compact"); }, async reflect(r: ReflectReq) { asks.push(r); const src = r.sources[0]!; return { ...out, memories: out.memories.map(m => ({ ...m, anchors: m.anchors.map(a => a.replaceAll("ROOM", src.roomId)), roomId: src.roomId, sourceSeq: src.seq, evidence: src.text })) }; } }),
  });
  const c = host.createContact({ name: "小克", speakingModel: "model-k", persona: "负责部署与发布" });
  const dm = host.openDm(c.id);
  host.send({ roomId: dm.id, clientActionId: "1", text: "以后部署前先跑测试" });
  await settle(host);
  assert.equal(asks.length, 1, "联系人没调 remember 也固定检查一次");
  assert.deepEqual(asks[0]!.sources?.map(x => x.seq), [1], "检查拿到宿主冻结的真实来源");
  assert.equal(asks[0]!.contact.speakingModel, "model-k");
  assert.match(asks[0]!.contact.persona, /负责部署与发布/);
  assert.match(asks[0]!.material, /以后部署前先跑测试/);
  assert.equal(asks[0]!.noteWritten, null);
  assert.equal(host.stateNote(c.id), "笔记:用户定了部署规矩", "模型没写笔记时用检查给的笔记");
  const [m] = host.listMemories(c.id);
  assert.equal(m!.body, "部署前先跑测试");
  assert.deepEqual(m!.source, { roomId: dm.id, seq: 1, userQuote: true, revision: 1, quote: "以后部署前先跑测试", senderId: host.userId });
  host.send({ roomId: dm.id, clientActionId: "2", text: "以后部署前先跑测试，再发版吧" });
  await settle(host);
  assert.match(b(reqs.at(-1)!, 5), /部署前先跑测试/, "读回到新消息旁边");
  assert.deepEqual(asks[1]!.neighbors.map((x) => x.id), [m!.id], "第二次检查带上邻域记忆,便于判关系");
  assert.equal(host.listMemories(c.id).length, 1, "同一件事只挂佐证不新增");
  assert.equal(host.listMemories(c.id)[0]!.evidence.length, 1);
  out = { note: null, memories: [], personaSuggestion: null };
  await host.close();
});

test("模型自己写了笔记时检查不改笔记;检查失败不影响本轮落盘;人格不改,建议改人格只记一条且不进任何一块", async () => {
  const reqs: RoundInput["request"][] = [];
  const reports: string[] = [];
  let mode: "ok" | "fail" = "ok";
  const host = new Host({
    ...fresh(), maxDeferMs: 5, onReport: (w) => reports.push(w),
    mind: () => ({ async round(i: RoundInput) { reqs.push(i.request); return { actions: [], stateNote: "模型自己的笔记" }; } }),
    compactor: () => ({
      async compact() { return "不该用"; },
      async reflect(r: ReflectReq): Promise<ReflectOut> {
        if (mode === "fail") throw new Error("上游 500");
        assert.equal(r.noteWritten, "模型自己的笔记");
        return { note: "检查想改的笔记", memories: [], personaSuggestion: "说话可以再短一点" };
      },
    }),
  });
  const c = host.createContact({ name: "小克", persona: "原人设" });
  const dm = host.openDm(c.id);
  host.send({ roomId: dm.id, clientActionId: "1", text: "嗯" });
  await settle(host);
  assert.equal(host.stateNote(c.id), "模型自己的笔记");
  assert.equal(host.contactView(host.contactDoc(c.id).value).name, "小克");
  assert.equal(host.contactDoc(c.id).value.persona, "原人设", "人格不随压缩改");
  assert.deepEqual(host.personaSuggestions(c.id), ["说话可以再短一点"]);
  host.send({ roomId: dm.id, clientActionId: "2", text: "嗯嗯" });
  await settle(host);
  assert.deepEqual(host.personaSuggestions(c.id), ["说话可以再短一点"], "同一建议只记一条");
  assert.doesNotMatch(reqs.at(-1)!.blocks.map((x) => x.text).join(""), /说话可以再短一点/);
  mode = "fail";
  host.send({ roomId: dm.id, clientActionId: "3", text: "继续" });
  await settle(host);
  assert.ok(reports.includes("reflect-failed"));
  assert.equal(host.stateNote(c.id), "模型自己的笔记");
  await host.close();
});
