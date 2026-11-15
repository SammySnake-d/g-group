// PR #95 第 2 轮探针(审查人 Claude):真实 Host,规则替身 compactor(不调模型),临时库。
// A:6 条都命中的记忆 → 粗筛/精筛邻域应是 6 条(检索函数默认上限是 5)。
// B:同一批两条用户消息,原文证据分别是 ZEBRAQUARTZ / MANGOLANTERN,各有一条只命中其一的记忆 → 精筛邻域应两条都有。
// 用法: node probe-r2.mjs <仓库绝对路径>   任一项不符退出 1。
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import { pathToFileURL } from "node:url";
const repo = process.argv[2]; const imp = (p) => import(pathToFileURL(path.join(repo, p)));
const { Host } = await imp("packages/server/src/host.ts"); const { MemoryStore } = await imp("packages/server/src/memory-store.ts");
const empty = () => ({ note: null, memories: [], personaSuggestion: null });
async function until(ready, what) { const end = Date.now() + 6000; while (!ready()) { if (Date.now() > end) throw new Error(`没等到:${what}`); await new Promise((r) => setTimeout(r, 5)); } }
async function scene(evidenceOf, seeds, texts) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pr95-r2-probe-")); const coarse = [], fine = [];
  const host = new Host({ file: path.join(dir, "db.sqlite"), dataDir: dir, maxDeferMs: 2, fineScreen: { quietMs: 40 },
    mind: () => ({ async round() { return { actions: [], stateNote: "MAIN" }; } }),
    compactor: () => ({ async compact() { return "MAIN"; },
      async reflect(request) { coarse.push(request); return { ...empty(), marks: request.sources.filter((s) => s.senderKind === "user" && evidenceOf(s.text)).map((s) => ({ roomId: s.roomId, seq: s.seq, kind: "fact", evidence: evidenceOf(s.text) })) }; },
      async refine(request) { fine.push(request); return { memories: [] }; } }) });
  try {
    const contact = host.createContact({ name: "fixture", speakingModel: "fixture-model" }); const room = host.openDm(contact.id);
    const store = new MemoryStore(host.db, path.join(dir, "memory"), () => {}); const now = "2026-01-01T00:00:00.000Z";
    for (const [id, title, body] of seeds) store.put(contact.id, { id, version: 1, status: "active", title, body, anchors: ["global"], validFrom: null, validTo: null, source: null, supersedes: [], supersededBy: null, refines: [], conflictsWith: [], derivedFrom: [], evidence: [], uses: [], createdAt: now, updatedAt: now });
    texts.forEach((text, i) => host.send({ roomId: room.id, clientActionId: `m${i}`, text }));
    await until(() => coarse.length > 0 && fine.length > 0, "粗筛与精筛请求"); await host.idle();
    return { coarseCalls: coarse.length, fineCalls: fine.length, fineBatchMarks: fine.map((f) => (f.marks ?? f.batch ?? f.sources ?? []).length), coarse: coarse.map((c) => c.neighbors.map((n) => n.id)), fine: fine.map((f) => f.neighbors.map((n) => n.id)) };
  } finally { await host.close(); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
}
const N = "NEIGHBOR_MATCH_NEEDLE";
const A = await scene((t) => (t.includes(N) ? N : null), ["m-a", "m-b", "m-c", "m-d", "m-e", "m-f"].map((id) => [id, N, N]), [N]);
const B = await scene((t) => (t.includes("ZEBRAQUARTZ") ? "ZEBRAQUARTZ" : t.includes("MANGOLANTERN") ? "MANGOLANTERN" : null), [["m-alpha", "甲", "ZEBRAQUARTZ 的旧记忆"], ["m-beta", "乙", "MANGOLANTERN 的旧记忆"]], ["ZEBRAQUARTZ 第一条", "MANGOLANTERN 第二条"]);
const okA = A.coarse[0].length === 6 && A.fine[0].length === 6;
const fineUnion = [...new Set(B.fine.flat())].sort(); const okB = B.fine.some((f) => f.includes("m-alpha") && f.includes("m-beta"));
console.log(JSON.stringify({ repo, A: { ok: okA, ...A }, B: { ok: okB, fineUnion, ...B } }, null, 1));
process.exit(okA && okB ? 0 : 1);
