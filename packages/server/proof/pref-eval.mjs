#!/usr/bin/env node
// 长对话后约束与偏好还在不在(需求文档 D25 第 10 节待测「压缩后用户偏好还在不在」、用户 g-group#2393 定为上线前实测)。
// 真实 pi 联系人脑子 + 宿主压缩器(有 reflect 就每轮检查写记忆)经模型网关;Compute 用脚本假件。
// 每个场景:第 1 条消息定下偏好或规矩,之后一条一条发 N 条无关消息(每条单独一轮,前面的原文离开第 4 块),
// 最后看「偏好生效之后的每条回复」是否照做,以及最后几条是否照做。
// 用法:node packages/server/proof/pref-eval.mjs --reps 2 --filler 8 --out /tmp/x.json [--model ...]
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import * as pi from "@g-group/adapter-pi-contact";
import { scriptedCompute } from "../src/fakes.ts";
import { Host } from "../src/host.ts";

const { values } = parseArgs({
  options: {
    reps: { type: "string", default: "2" },
    filler: { type: "string", default: "8" },
    out: { type: "string" },
    label: { type: "string", default: "" },
    model: { type: "string" },
  },
});

const FILLER = ["17 乘 23 是多少", "推荐一本讲时间管理的书", "hello 倒过来怎么拼", "今天好困啊", "2 的 10 次方是多少", "给我一个以 z 开头的英文单词", "周末去哪玩比较好", "解释一下什么是缓存", "3 加 5 等于几", "随便讲个冷知识"];
const cjk = (t) => (t.match(/[一-鿿]/g) ?? []).length;
export const SCENARIOS = [
  { id: "P1-回复用英文", setup: "以后你回复我都用英文,别用中文", ok: (t) => cjk(t) <= 2 },
  { id: "P2-末尾署名", setup: "以后你每条回复末尾都要署名「—小克」", ok: (t) => /—\s*小克\s*$/.test(t.trim()) },
  { id: "P3-计算结果标已核对", setup: "以后回答里出现的计算结果,都在后面加上「(已核对)」四个字", ok: (t) => !/\d/.test(t) || /已核对/.test(t) },
];

const env = (k) => (process.env[k]?.trim() ? process.env[k] : undefined);

async function runOnce(scn, rep, model, filler) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "gg-pref-"));
  const bearer = env("ANTHROPIC_AUTH_TOKEN");
  const apiKey = bearer ?? env("ANTHROPIC_API_KEY");
  const piOpts = { provider: "anthropic", model, baseUrl: env("ANTHROPIC_BASE_URL") ?? "https://api.anthropic.com", apiKey, authHeader: bearer ? "bearer" : "x-api-key" };
  const mind = pi.createPiContactMind(piOpts);
  const compactor = typeof pi.createPiCompactor === "function" ? pi.createPiCompactor(piOpts) : null;
  const compute = scriptedCompute({ stepMs: 30 });
  const reports = [];
  const host = new Host({ file: path.join(dir, "gg.db"), dataDir: dir, mind: () => mind, ...(compactor ? { compactor: () => compactor } : {}), compute: () => compute.adapter, maxDeferMs: 200, onReport: (w) => reports.push(w) });
  const replies = [];
  let phase = -1;
  host.bus.subscribe((e) => {
    if (e.type === "message.appended" && e.message.sender.kind === "contact") replies.push({ phase, text: e.message.text });
  });
  const waitIdle = async () => {
    const end = Date.now() + 180_000;
    for (;;) {
      await host.idle();
      await new Promise((r) => setTimeout(r, 400));
      if (!host.loop.busy() || Date.now() > end) return;
    }
  };
  try {
    host.updateSettings({ defaultComputeModel: model, defaultSpeakingModel: model });
    const c = host.createContact({ name: "小克" });
    const room = host.openDm(c.id);
    const msgs = [scn.setup, ...FILLER.slice(0, filler)];
    for (let i = 0; i < msgs.length; i++) {
      phase = i;
      host.send({ roomId: room.id, clientActionId: `m${i}`, text: msgs[i] });
      await waitIdle();
    }
    const after = replies.filter((r) => r.phase >= 1);
    const okAfter = after.filter((r) => scn.ok(r.text)).length;
    const tail = after.filter((r) => r.phase >= msgs.length - 3);
    const okTail = tail.filter((r) => scn.ok(r.text)).length;
    const memories = typeof host.listMemories === "function" ? host.listMemories(c.id).map((m) => ({ id: m.id, status: m.status, anchors: m.anchors, title: m.title, body: m.body })) : null;
    return { scenario: scn.id, rep, okAfter, after: after.length, okTail, tail: tail.length, note: host.stateNote?.(c.id) ?? null, memories, reports: [...new Set(reports)], transcript: host.listMessages(room.id, { limit: 200 }).messages.map((m) => `#${m.seq} ${m.sender.kind === "user" ? "我" : "小克"}: ${m.text}`) };
  } finally {
    compute.close();
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const model = values.model ?? env("ANTHROPIC_DEFAULT_SONNET_MODEL");
if (!model) throw new Error("缺模型");
const runs = [];
for (const scn of SCENARIOS) {
  for (let rep = 1; rep <= Number(values.reps); rep++) {
    let r;
    try {
      r = await runOnce(scn, rep, model, Number(values.filler));
    } catch (e) {
      r = { scenario: scn.id, rep, error: String(e?.message ?? e), okAfter: 0, after: 0, okTail: 0, tail: 0 };
    }
    runs.push(r);
    console.log(`${scn.id} #${rep}: 偏好之后 ${r.okAfter}/${r.after} 照做,最后 3 轮 ${r.okTail}/${r.tail}${r.memories ? `,记忆 ${r.memories.length} 条` : ""}${r.error ? ` 错误:${r.error}` : ""}`);
  }
}
const sum = (k) => runs.reduce((a, r) => a + r[k], 0);
const summary = { okAfter: sum("okAfter"), after: sum("after"), okTail: sum("okTail"), tail: sum("tail") };
console.log(`汇总 ${values.label}:`, JSON.stringify(summary));
if (values.out) writeFileSync(values.out, JSON.stringify({ label: values.label, model, at: new Date().toISOString(), summary, runs }, null, 2));
