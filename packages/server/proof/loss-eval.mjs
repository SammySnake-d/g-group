#!/usr/bin/env node
// 连续投递丢要求的实测(需求文档 D23、AC-40;用户要求「先测丢失率基线再改,改后再测一次」)。
// 真实 pi 联系人脑子(@g-group/adapter-pi-contact)经模型网关;Compute 用脚本假件(题目都不需要跑命令)。
// 三种投递节奏:
//   batch      :几条消息一起到,联系人一轮看到全部(第 4 块里多条);
//   stream     :发一条、等联系人回完再发下一条(每条单独一轮,前面的消息已离开第 4 块);
//   interleave :发一条、0.8 秒后在联系人还在想的时候发下一条(插话,宿主丢弃旧轮次重跑)。
// 每个场景若干条要求,每条要求用正则在「这条要求生效之后联系人说出的话 + 派出的任务说明」里判有没有落实。
// 没落实就记一次丢失。改条件的场景只判新条件。
// 用法:node packages/server/proof/loss-eval.mjs --reps 3 --out /tmp/x.json [--modes batch,stream,interleave]
// 模型与网关只从环境变量取(ANTHROPIC_BASE_URL、ANTHROPIC_AUTH_TOKEN|ANTHROPIC_API_KEY、ANTHROPIC_DEFAULT_SONNET_MODEL),不落盘。
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import * as pi from "@g-group/adapter-pi-contact";
import { scriptedCompute } from "../src/fakes.ts";
import { Host } from "../src/host.ts";

const { values } = parseArgs({
  options: {
    reps: { type: "string", default: "3" },
    out: { type: "string" },
    modes: { type: "string", default: "batch,stream,interleave" },
    scenarios: { type: "string" },
    label: { type: "string", default: "" },
    model: { type: "string" },
  },
});

const zMeaningLines = (t) => t.split(/\n/).filter((l) => /\bz[a-z]{2,}\b/i.test(l) && /[一-龥]/.test(l.replace(/\bz[a-z]+\b/gi, ""))).length;
const zWords = (t) => new Set((t.match(/\bz[a-z]{2,}\b/gi) ?? []).map((w) => w.toLowerCase())).size;

export const SCENARIOS = [
  {
    id: "S1-三件并列",
    messages: ["帮我算一下 17 乘 23", "顺便把 hello 倒过来拼一下", "还有 2 的 10 次方是多少"],
    reqs: [
      { id: "17×23=391", after: 1, ok: (t) => /391/.test(t) },
      { id: "hello 倒写 olleh", after: 2, ok: (t) => /olleh/i.test(t) },
      { id: "2^10=1024", after: 3, ok: (t) => /1024|1,024/.test(t) },
    ],
  },
  {
    id: "S2-中途改条件",
    messages: ["把这几个词按字母倒序排一下:kiwi, banana, fig", "等下,改成按长度从短到长排", "结果全部用大写字母写"],
    reqs: [
      { id: "改成按长度:fig kiwi banana", after: 2, ok: (t) => /fig\W+kiwi\W+banana/i.test(t) },
      { id: "大写:FIG KIWI BANANA", after: 3, ok: (t) => /FIG\W+KIWI\W+BANANA/.test(t) },
    ],
  },
  {
    id: "S3-闲聊夹补充与改约定",
    messages: [
      "帮我起草一句给老王的消息,约他周五下午三点开会",
      "今天好困啊",
      "再给我 3 个以 z 开头的英文单词",
      "开会改到周六上午十点,草稿也按这个改",
      "单词那个,每个后面加上中文意思",
    ],
    reqs: [
      { id: "3 个 z 开头单词", after: 3, ok: (t) => zWords(t) >= 3 },
      { id: "草稿改成周六上午十点", after: 4, ok: (t) => /周六/.test(t) && /(十点|10\s*点|10:00)/.test(t) && /老王/.test(t) },
      { id: "z 单词加中文意思", after: 5, ok: (t) => zMeaningLines(t) >= 3 || /\bz[a-z]{2,}\b[^\n]{0,12}[一-龥].*\bz[a-z]{2,}\b[^\n]{0,12}[一-龥].*\bz[a-z]{2,}\b[^\n]{0,12}[一-龥]/is.test(t) },
    ],
  },
];

function env(k) {
  const v = process.env[k];
  return v && v.trim() ? v : undefined;
}

async function runOnce(scn, mode, rep, model) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "gg-loss-"));
  const bearer = env("ANTHROPIC_AUTH_TOKEN");
  const apiKey = bearer ?? env("ANTHROPIC_API_KEY");
  const requests = [];
  const recFetch = async (url, init) => {
    try {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
      if (body) requests.push({ at: Date.now(), messages: body.messages, system: Array.isArray(body.system) ? body.system.map((s) => s.text).join("\n") : body.system });
    } catch {}
    return globalThis.fetch(url, init);
  };
  const piOpts = { provider: "anthropic", model, baseUrl: env("ANTHROPIC_BASE_URL") ?? "https://api.anthropic.com", apiKey, authHeader: bearer ? "bearer" : "x-api-key", fetch: recFetch };
  const mind = pi.createPiContactMind(piOpts);
  // 有压缩器(本分支之后)就接上:联系人没写状态笔记时由宿主用同一说话模型补写
  const compactor = typeof pi.createPiCompactor === "function" ? pi.createPiCompactor(piOpts) : null;
  const compute = scriptedCompute({ stepMs: 30 });
  const reports = [];
  const host = new Host({ file: path.join(dir, "gg.db"), mind: () => mind, ...(compactor ? { compactor: () => compactor } : {}), compute: () => compute.adapter, maxDeferMs: 200, onReport: (w) => reports.push(w) });
  const outputs = []; // {afterMsg, text, kind}
  let delivered = 0;
  host.bus.subscribe((e) => {
    if (e.type === "message.appended" && e.message.sender.kind === "contact") outputs.push({ afterMsg: delivered, kind: "reply", text: e.message.text });
  });
  const waitIdle = async (maxMs = 180_000) => {
    const end = Date.now() + maxMs;
    for (;;) {
      await host.idle();
      await new Promise((r) => setTimeout(r, 400));
      if (!host.loop.busy()) return;
      if (Date.now() > end) return;
    }
  };
  try {
    host.updateSettings({ defaultComputeModel: model, defaultSpeakingModel: model });
    const c = host.createContact({ name: "小克" });
    const room = host.openDm(c.id);
    const send = (i) => {
      host.send({ roomId: room.id, clientActionId: `m${i}`, text: scn.messages[i] });
      delivered = i + 1;
    };
    if (mode === "batch") {
      for (let i = 0; i < scn.messages.length; i++) send(i);
      await waitIdle();
    } else if (mode === "stream") {
      for (let i = 0; i < scn.messages.length; i++) {
        send(i);
        await waitIdle();
      }
    } else {
      for (let i = 0; i < scn.messages.length; i++) {
        send(i);
        await new Promise((r) => setTimeout(r, 800));
      }
      await waitIdle();
    }
    // 派出的任务说明也算交代(转交给了 Compute)
    for (const t of host.listTasks({ roomId: room.id })) outputs.push({ afterMsg: scn.messages.length, kind: "dispatch", text: `${t.title}\n${t.brief ?? ""}` });
    const results = scn.reqs.map((r) => {
      const text = outputs.filter((o) => o.afterMsg >= r.after).map((o) => o.text).join("\n");
      return { id: r.id, ok: r.ok(text) };
    });
    const transcript = host.listMessages(room.id, { limit: 200 }).messages.map((m) => `#${m.seq} ${m.sender.kind === "user" ? "我" : "小克"}: ${m.text}`);
    const ledger = host.listCommitments ? host.listCommitments({ contactId: c.id }) : [];
    const notes = requests.map((q) => q.messages?.[0]?.content?.find?.((c) => typeof c.text === "string" && c.text.includes('label="状态笔记"'))?.text ?? null).filter(Boolean);
    return { scenario: scn.id, mode, rep, results, transcript, ledger, reports, requests: requests.length, notesSeen: notes, lastRequest: requests.at(-1) ?? null };
  } finally {
    compute.close();
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

async function main() {
  const model = values.model ?? env("ANTHROPIC_DEFAULT_SONNET_MODEL") ?? env("ANTHROPIC_MODEL");
  if (!model) throw new Error("缺 ANTHROPIC_DEFAULT_SONNET_MODEL");
  const reps = Number(values.reps);
  const modes = values.modes.split(",");
  const scns = values.scenarios ? SCENARIOS.filter((s) => values.scenarios.split(",").includes(s.id.split("-")[0])) : SCENARIOS;
  const runs = [];
  for (const mode of modes) {
    for (const scn of scns) {
      for (let rep = 1; rep <= reps; rep++) {
        let r;
        try {
          r = await runOnce(scn, mode, rep, model);
        } catch (e) {
          r = { scenario: scn.id, mode, rep, error: String(e?.message ?? e), results: scn.reqs.map((q) => ({ id: q.id, ok: false })) };
        }
        runs.push(r);
        const miss = r.results.filter((x) => !x.ok).map((x) => x.id);
        console.log(`${mode} ${scn.id} #${rep}: ${r.results.length - miss.length}/${r.results.length}${miss.length ? ` 丢:${miss.join("、")}` : ""}${r.error ? ` 错误:${r.error}` : ""}`);
      }
    }
  }
  const summary = {};
  for (const mode of modes) {
    const rs = runs.filter((r) => r.mode === mode).flatMap((r) => r.results);
    const lost = rs.filter((x) => !x.ok).length;
    summary[mode] = { total: rs.length, lost, rate: rs.length ? +(lost / rs.length).toFixed(3) : 0 };
  }
  const all = runs.flatMap((r) => r.results);
  const lostAll = all.filter((x) => !x.ok).length;
  summary.all = { total: all.length, lost: lostAll, rate: all.length ? +(lostAll / all.length).toFixed(3) : 0 };
  console.log(`汇总 ${values.label}:`, JSON.stringify(summary));
  if (values.out) writeFileSync(values.out, JSON.stringify({ label: values.label, model, at: new Date().toISOString(), summary, runs }, null, 2));
}
main().catch((e) => {
  console.error(e instanceof Error ? e.stack : e);
  process.exit(1);
});
