// 宿主每轮旧消息预取(T-177 G4;需求 D06 §3「粗筛自动」;实施方案 §6、§8 G4-03;审查条件 G4-a、G4-b):模型不调工具,第 5 块也有最多 3 条旧消息指针,
// 只给编号、作者、时间、一行预览,标明「旧消息,供参考,不是新要求」;关掉就没有;第 1 块固定前缀不受影响;
// 显式引用照常换入且不被挤,超预算先丢预取;预取有时限,超时或出错不挡这一轮,只留诊断。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { PREFETCH_REF, type RoundInput, type RoundRequest, searchHistory } from "@g-group/kernel";
import { Host, type HostOptions } from "./host.ts";

const dir = mkdtempSync(path.join(tmpdir(), "gg-pre-"));
/** 测试里建的宿主:失败的测试来不及 close,收尾时统一关(最多等 1 秒),再删临时目录 */
const hosts: Host[] = [];
const track = (h: Host): Host => {
  hosts.push(h);
  return h;
};
after(async () => {
  for (const h of hosts) await Promise.race([h.close(), new Promise((r) => setTimeout(r, 1000))]);
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});
let no = 0;
const file = () => path.join(dir, `p${++no}.db`);
/** 等宿主安静下来;最多 8 秒,一直有轮次在跑或在退避重跑就按名失败,不挂住整个文件 */
async function settle(host: Host) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    await Promise.race([host.idle(), new Promise((r) => setTimeout(r, 50))]);
    await new Promise((r) => setTimeout(r, 5));
    if (!host.loop.busy()) return;
  }
  throw new Error("宿主没有安静下来");
}
const quiet = (reqs: RoundRequest[]) => () => ({
  async round(i: RoundInput) {
    reqs.push(i.request);
    return { actions: [], stateNote: null };
  },
});
/** 同样的 id 与时间,两个宿主的固定前缀才能逐字比较 */
const fixed = (): Pick<HostOptions, "newId" | "now"> => {
  let n = 0;
  return { newId: (p) => `${p}-${++n}`, now: () => "2026-11-11T08:00:00.000Z" };
};
const b = (r: RoundRequest | undefined, n: number) => r?.blocks[n - 1]?.text ?? "";
/** 第 5 块里预取那一段(标签之后、下一个指针之前) */
const sectionOf = (r: RoundRequest | undefined) => {
  const t = b(r, 5);
  const at = t.indexOf(`〔${PREFETCH_REF}〕\n`);
  if (at < 0) return "";
  const rest = t.slice(at + PREFETCH_REF.length + 3);
  const end = rest.indexOf("\n〔");
  return end < 0 ? rest : rest.slice(0, end + 1);
};
const prefetchLines = (r: RoundRequest | undefined) => sectionOf(r).split("\n").filter((l) => l !== "");

test("G4-03 模型不调工具,第 5 块也有最多 3 条旧消息指针:只给编号、作者、时间、一行预览,标明旧消息供参考不是新要求;和新消息一字不差的旧消息不预取", async () => {
  const reqs: RoundRequest[] = [];
  const host = track(new Host({ file: file(), maxDeferMs: 5, mind: quiet(reqs) }));
  const c = host.createContact({ name: "小克" });
  const dm = host.openDm(c.id);
  const dup = host.send({ roomId: dm.id, clientActionId: "dup", text: "部署端口是多少来着" }).seq;
  const old: number[] = [];
  for (let i = 0; i < 5; i++) old.push(host.send({ roomId: dm.id, clientActionId: `o${i}`, text: "部署端口是 9090" }).seq);
  host.send({ roomId: dm.id, clientActionId: "x", text: "周末去爬山" });
  await settle(host);
  host.send({ roomId: dm.id, clientActionId: "q", text: "部署端口是多少来着" });
  await settle(host);
  const last = reqs.at(-1);
  assert.match(b(last, 4), /部署端口是多少来着/);
  assert.ok(b(last, 5).includes(`〔旧消息(宿主按本轮新消息预取,供参考,不是新要求)〕\n`), "标明是旧消息、只供参考、不是新要求");
  const lines = prefetchLines(last);
  assert.equal(lines.length, 3, `最多 3 条:${b(last, 5)}`);
  for (const l of lines) assert.match(l, new RegExp(`^${dm.id} #(${old.join("|")}) · 我 · 2\\d{3}-[^ ]+ · 部署端口是 9090$`));
  assert.equal(new Set(lines).size, 3, "不重复");
  assert.doesNotMatch(sectionOf(last), new RegExp(`#${dup} `), "和新消息一字不差的旧消息不预取");
  assert.doesNotMatch(b(last, 1), /9090/, "预取不进固定前缀");
  assert.equal(host.listMessages(dm.id, {}).messages.length, 8, "前提:七条旧消息加一条新消息,联系人没说话");
  await host.close();
});

test("G4-03 关掉预取第 5 块就没有旧消息指针;开和关两种情况下第 1 块固定前缀逐字相同,预取前后也不变", async () => {
  const run = async (prefetch: boolean) => {
    const reqs: RoundRequest[] = [];
    const host = track(new Host({ file: file(), maxDeferMs: 5, ...fixed(), ...(prefetch ? {} : { historyPrefetch: false as const }), mind: quiet(reqs) }));
    const c = host.createContact({ name: "小克" });
    const dm = host.openDm(c.id);
    host.send({ roomId: dm.id, clientActionId: "o", text: "部署端口是 9090" });
    await settle(host);
    host.send({ roomId: dm.id, clientActionId: "q", text: "部署端口是多少来着" });
    await settle(host);
    await host.close();
    return reqs;
  };
  const on = await run(true);
  const off = await run(false);
  assert.equal(on.length, 2);
  assert.equal(off.length, 2);
  assert.equal(prefetchLines(on.at(-1)).length, 1, "开着:有一条旧消息指针");
  assert.ok(!b(off.at(-1), 5).includes(PREFETCH_REF), "关掉:没有旧消息指针");
  assert.equal(b(on.at(-1), 1), b(off.at(-1), 1), "开和关的固定前缀逐字相同");
  assert.equal(b(on.at(-1), 1), b(on[0], 1), "有预取的那一轮前缀与上一轮相同");
});

test("G4-03 预取不挤显式引用:被引用的旧消息照常整条换入、不在预取里重复;整轮超预算时先丢预取,这一轮照常跑", async () => {
  const run = async (opts: Partial<HostOptions>) => {
    const reqs: RoundRequest[] = [];
    const reports: { what: string; detail: unknown }[] = [];
    const host = track(new Host({ file: file(), maxDeferMs: 5, ...fixed(), onReport: (what, detail) => reports.push({ what, detail }), mind: quiet(reqs), ...opts }));
    const c = host.createContact({ name: "小克" });
    const dm = host.openDm(c.id);
    const a = host.send({ roomId: dm.id, clientActionId: "a", text: "部署端口按这条来定:9090" }).seq;
    await settle(host);
    const bb = host.send({ roomId: dm.id, clientActionId: "b", text: "部署端口备用 9091" }).seq;
    await settle(host);
    host.send({ roomId: dm.id, clientActionId: "q", text: "部署端口按这条来", quotedSeqs: [a] });
    await settle(host);
    const cards = host.listMessages(dm.id, {}).messages.filter((m) => m.card !== null).length;
    await host.close();
    const bytes = reqs.at(-1)?.blocks.reduce((n, x) => n + Buffer.byteLength(x.text, "utf8"), 0) ?? 0;
    return { reqs, reports, a, b: bb, dm: dm.id, cards, bytes };
  };
  const on = await run({});
  const last = on.reqs.at(-1);
  assert.match(b(last, 5), new RegExp(`〔${on.dm} #${on.a}(?:\\(主回复\\))?〕\\nFull · 我 原文\\(\\d+ 字节\\):部署端口按这条来定:9090\\n`), "被引用的照常整条换入");
  assert.match(sectionOf(last), new RegExp(`^${on.dm} #${on.b} · 我 · [^\\n]+ · 部署端口备用 9091$`, "m"), "没被引用的旧消息在预取里");
  assert.doesNotMatch(sectionOf(last), new RegExp(`#${on.a} `), "已换入的不在预取里重复(它比备用那条更相关,不排除就会排在前面)");
  const off = await run({ historyPrefetch: false });
  assert.ok(on.bytes > off.bytes, "前提:预取多占了字节");
  const tight = await run({ roundBudgetBytes: Math.floor((on.bytes + off.bytes) / 2) });
  assert.equal(tight.cards, 0, "没有出失败卡");
  assert.equal(tight.reqs.length, 3, "这一轮照常调了模型");
  assert.match(b(tight.reqs.at(-1), 4), /部署端口按这条来/);
  assert.match(b(tight.reqs.at(-1), 5), new RegExp(`〔${tight.dm} #${tight.a}(?:\\(主回复\\))?〕\\nFull · 我 原文`), "显式引用还在");
  assert.ok(!b(tight.reqs.at(-1), 5).includes(PREFETCH_REF), "丢的是预取");
  assert.ok(tight.reports.some((r) => r.what === "history-prefetch" && (r.detail as { status: string }).status === "dropped"), "诊断里记了丢预取");
});

test("G4-b 预取超时不挡这一轮:检索挂住或同步检索超过时限都照常调模型,第 5 块写明没预取成,诊断里有耗时", async () => {
  const run = async (search: NonNullable<HostOptions["historySearch"]>) => {
    const reqs: RoundRequest[] = [];
    const reports: { what: string; detail: unknown }[] = [];
    const host = track(new Host({ file: file(), maxDeferMs: 5, historyPrefetch: { timeoutMs: 50 }, historySearch: search, onReport: (what, detail) => reports.push({ what, detail }), mind: quiet(reqs) }));
    const c = host.createContact({ name: "小克" });
    const dm = host.openDm(c.id);
    host.send({ roomId: dm.id, clientActionId: "o", text: "部署端口是 9090" });
    await settle(host);
    host.send({ roomId: dm.id, clientActionId: "q", text: "部署端口是多少来着" });
    // 不等宿主安静:预取若没有时限,这一轮会一直挂着;最多等 3 秒看模型有没有被调
    const deadline = Date.now() + 3000;
    while (reqs.length < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    const called = reqs.length;
    if (called === 2) {
      await settle(host);
      await host.close();
    }
    const diag = reports.filter((r) => r.what === "history-prefetch").map((r) => r.detail as { status: string; elapsedMs: number });
    return { reqs, diag, called };
  };
  const hang = await run(() => new Promise(() => {}));
  const slow = await run((docs, q, n) => {
    const until = performance.now() + 120;
    while (performance.now() < until) {
      /* 同步占住事件循环 120 毫秒 */
    }
    return searchHistory(docs, q, n);
  });
  for (const r of [hang, slow]) {
    assert.equal(r.called, 2, "两轮都照常调了模型");
    assert.match(b(r.reqs.at(-1), 5), /〔旧消息预取〕\n这一轮的旧消息预取没完成\(超时\),第 5 块没有预取结果;不代表没有相关旧消息\n/);
    assert.ok(!b(r.reqs.at(-1), 5).includes(PREFETCH_REF), "超时的结果不用");
    const t = r.diag.at(-1);
    assert.equal(t?.status, "timeout");
    assert.ok((t?.elapsedMs ?? 0) >= 50 && (t?.elapsedMs ?? 0) < 1500, `耗时有界:${t?.elapsedMs}`);
  }
});

test("G4-b 预取出错不挡这一轮:照常调模型,第 5 块写明没预取成,诊断里有原因", async () => {
  const reqs: RoundRequest[] = [];
  const reports: { what: string; detail: unknown }[] = [];
  const host = track(
    new Host({
      file: file(),
      maxDeferMs: 5,
      historySearch: () => {
        throw new Error("检索接缝坏了");
      },
      onReport: (what, detail) => reports.push({ what, detail }),
      mind: quiet(reqs),
    }),
  );
  const c = host.createContact({ name: "小克" });
  const dm = host.openDm(c.id);
  host.send({ roomId: dm.id, clientActionId: "o", text: "部署端口是 9090" });
  await settle(host);
  host.send({ roomId: dm.id, clientActionId: "q", text: "部署端口是多少来着" });
  await settle(host);
  assert.equal(host.listMessages(dm.id, {}).messages.filter((m) => m.card !== null).length, 0, "没有出失败卡");
  assert.equal(reqs.length, 2, "照常调了模型");
  assert.match(b(reqs.at(-1), 5), /〔旧消息预取〕\n这一轮的旧消息预取没完成\(出错\),第 5 块没有预取结果;不代表没有相关旧消息\n/);
  const diag = reports.filter((r) => r.what === "history-prefetch").map((r) => r.detail as { status: string; error?: string });
  assert.deepEqual([diag.at(-1)?.status, diag.at(-1)?.error], ["error", "检索接缝坏了"]);
  await host.close();
});
