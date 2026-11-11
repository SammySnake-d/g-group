// T-177 G2 = D(AC-32 ③):一轮里对话、补写、检查共用同一份冻结的配置快照;配置在途改变不影响本轮,下一轮才用新值;
// 压缩器报的绑定模型与本轮快照不同就一次都不发、保留原文、不换模型。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { modelConfig } from "@g-group/domain";
import type { ReflectRequest } from "@g-group/kernel";
import { Host, type HostOptions } from "./host.ts";

type Snapshot = modelConfig.EffectiveSpeakingConfig;
async function until(check: () => boolean): Promise<void> {
  const end = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > end) throw new Error("等不到具名行为");
    await new Promise((r) => setTimeout(r, 5));
  }
}
const EP: modelConfig.SpeakingEndpoint = { provider: "anthropic", baseUrl: "http://127.0.0.1:9/neutral", authRef: "none", maxOutputTokens: 8192, contextWindow: 200_000 };
function world(H: typeof Host, t: { after(fn: () => Promise<void>): void }, over: Partial<HostOptions> & Pick<HostOptions, "mind">): Host {
  const dir = mkdtempSync(path.join(tmpdir(), "gg-speaking-snapshot-"));
  const host = new H({ file: path.join(dir, "db.sqlite"), dataDir: dir, maxDeferMs: 2, retry: { maxAutoRetries: 0, unknownMaxRetries: 0 }, ...over });
  t.after(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  return host;
}

test("G2-01 同一轮对话与补写检查收到同一份冻结快照", async (t) => {
  const minds: Snapshot[] = [];
  const compactors: Snapshot[] = [];
  const reqs: ReflectRequest[] = [];
  const host = world(Host, t, {
    speakingEndpoint: () => EP,
    mind: (_c, s) => {
      minds.push(s);
      return { async round() { return { actions: [], stateNote: null }; } };
    },
    compactor: (_c, s) => {
      compactors.push(s);
      return { async compact() { return "笔记"; }, async reflect(r) { reqs.push(r); return { note: "笔记", memories: [], personaSuggestion: null }; } };
    },
  });
  const c = host.createContact({ name: "查证", speakingModel: "claude-sonnet-4-6" });
  const dm = host.openDm(c.id);
  host.send({ roomId: dm.id, clientActionId: "one", text: "NEUTRAL_FIXTURE_NO_CREDENTIALS" });
  await until(() => reqs.length === 1);
  await host.idle();
  assert.equal(minds.length, 1);
  assert.equal(compactors[0], minds[0], "压缩器工厂拿到的必须是对话用的同一个快照对象");
  assert.equal(Object.isFrozen(minds[0]), true);
  assert.equal(minds[0]?.maxOutputTokens, 8192, "输出上限取宿主级配置");
  assert.equal(minds[0]?.fingerprint, modelConfig.resolveSpeakingConfig(EP, "claude-sonnet-4-6", host.bootId).fingerprint, "指纹含宿主启动号");
  assert.equal(reqs[0]?.contact.speakingModel, minds[0]?.model, "检查请求里的模型就是快照里的模型");
});

test("G2-01 配置在途改变本轮保持旧值 下一轮才用新值", async (t) => {
  let endpoint: modelConfig.SpeakingEndpoint = EP;
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let entered = false;
  const minds: Snapshot[] = [];
  const compactors: Snapshot[] = [];
  const host = world(Host, t, {
    speakingEndpoint: () => endpoint,
    mind: (_c, s) => {
      minds.push(s);
      return {
        async round() {
          if (minds.length === 1) {
            entered = true;
            await gate;
          }
          return { actions: [], stateNote: null };
        },
      };
    },
    compactor: (_c, s) => {
      compactors.push(s);
      return { async compact() { return "笔记"; }, async reflect() { return { note: "笔记", memories: [], personaSuggestion: null }; } };
    },
  });
  const c = host.createContact({ name: "查证", speakingModel: "claude-sonnet-4-6" });
  const dm = host.openDm(c.id);
  host.send({ roomId: dm.id, clientActionId: "one", text: "第一条" });
  await until(() => entered);
  endpoint = { ...EP, maxOutputTokens: 16_384 };
  release();
  await until(() => compactors.length === 1);
  await host.idle();
  assert.equal(compactors[0]?.maxOutputTokens, 8192, "在途的这一轮保持开始时的值");
  assert.equal(compactors[0], minds[0]);
  host.send({ roomId: dm.id, clientActionId: "two", text: "第二条" });
  await until(() => compactors.length === 2);
  await host.idle();
  assert.equal(minds[1]?.maxOutputTokens, 16_384, "下一轮用新值");
  assert.equal(minds[1]?.fingerprint, modelConfig.resolveSpeakingConfig({ ...EP, maxOutputTokens: 16_384 }, c.speakingModel, host.bootId).fingerprint);
  assert.equal(compactors[1], minds[1]);
  assert.notEqual(minds[1]?.fingerprint, minds[0]?.fingerprint, "同一模型换了配置,指纹不同");
  assert.equal(minds[1]?.model, minds[0]?.model);
});

test("G2-02 压缩器绑定模型与本轮快照不同就不调用 不换模型", async (t) => {
  const reports: { what: string; detail: unknown }[] = [];
  let bound = "other-model";
  let calls = 0;
  const minds: Snapshot[] = [];
  const host = world(Host, t, {
    onReport: (what, detail) => reports.push({ what, detail }),
    mind: (_c, s) => {
      minds.push(s);
      return { async round() { return { actions: [], stateNote: null }; } };
    },
    compactor: () => ({
      model: bound,
      async compact() {
        calls++;
        return "笔记";
      },
      async reflect() {
        calls++;
        return { note: "笔记", memories: [], personaSuggestion: null };
      },
    }),
  });
  const c = host.createContact({ name: "查证", speakingModel: "claude-sonnet-4-6" });
  const dm = host.openDm(c.id);
  host.send({ roomId: dm.id, clientActionId: "one", text: "第一条" });
  await until(() => minds.length === 1);
  await host.idle();
  const mismatch = reports.filter((r) => r.what === "compression-model-mismatch");
  assert.equal(calls, 0, "绑定模型不同,一次都不发");
  assert.equal(mismatch.length, 1);
  assert.match(String((mismatch[0]?.detail as { reason?: string } | undefined)?.reason), /claude-sonnet-4-6.*other-model/);
  assert.equal(minds[0]?.model, c.speakingModel, "不换模型");
  bound = "claude-sonnet-4-6";
  host.send({ roomId: dm.id, clientActionId: "two", text: "第二条" });
  await until(() => calls === 1);
  await host.idle();
  assert.equal(reports.filter((r) => r.what === "compression-model-mismatch").length, 1, "同模就照常调用,不再报失配");
});

test("G2-02 同模校验用本轮冻结的模型 不用联系人中途改过的现值", async (t) => {
  const reports: string[] = [];
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let entered = false;
  const minds: Snapshot[] = [];
  const reqs: ReflectRequest[] = [];
  const host = world(Host, t, {
    onReport: (what) => reports.push(what),
    mind: (_c, s) => {
      minds.push(s);
      return {
        async round() {
          entered = true;
          await gate;
          return { actions: [], stateNote: null };
        },
      };
    },
    compactor: (_c, s) => ({
      model: s.model,
      async compact() { return "笔记"; },
      async reflect(r) {
        reqs.push(r);
        return { note: "笔记", memories: [], personaSuggestion: null };
      },
    }),
  });
  const c = host.createContact({ name: "查证", speakingModel: "claude-sonnet-4-6" });
  const dm = host.openDm(c.id);
  host.send({ roomId: dm.id, clientActionId: "one", text: "第一条" });
  await until(() => entered);
  host.updateContact(c.id, { speakingModel: "gpt-5" });
  release();
  await until(() => reqs.length === 1);
  await host.idle();
  assert.equal(reports.includes("compression-model-mismatch"), false, "本轮冻结的是开始时的模型,压缩器与它同模就照常调用");
  assert.equal(reqs[0]?.contact.speakingModel, minds[0]?.model);
  assert.equal(minds[0]?.model, "claude-sonnet-4-6");
  assert.equal(host.contactDoc(c.id).value.speakingModel, "gpt-5", "联系人的新模型从下一轮生效");
});

test("G2-02 失败卡选了备用模型的那一轮 同模校验按快照判并照常检查", async (t) => {
  const original = "claude-sonnet-4-6";
  const backup = "gpt-5";
  const reports: string[] = [];
  const reqs: ReflectRequest[] = [];
  let calls = 0;
  const host = world(Host, t, {
    onReport: (what) => reports.push(what),
    mind: () => ({
      async round() {
        if (++calls === 1) throw new Error("NEUTRAL_UPSTREAM_FAILURE");
        return { actions: [], stateNote: null };
      },
    }),
    compactor: (_c, s) => ({
      model: s.model,
      async compact() { return "笔记"; },
      async reflect(r) {
        reqs.push(r);
        return { note: "笔记", memories: [], personaSuggestion: null };
      },
    }),
  });
  host.updateSettings({ models: [{ id: original, label: "原模型", vendor: "anthropic", harnesses: ["claude-code"] }, { id: backup, label: "备用模型", vendor: "openai", harnesses: ["claude-code"] }] });
  const c = host.createContact({ name: "查证", speakingModel: original });
  const dm = host.openDm(c.id);
  host.send({ roomId: dm.id, clientActionId: "one", text: "第一条" });
  await until(() => host.listMessages(dm.id, {}).messages.some((m) => m.card?.kind === "failure"));
  const card = host.listMessages(dm.id, {}).messages.find((m) => m.card?.kind === "failure");
  assert.ok(card?.card);
  host.cardAct({ roomId: dm.id, seq: card.seq, cardId: card.card.cardId, actionId: `switch-model:${backup}`, clientActionId: "switch" });
  await until(() => reqs.length === 1);
  await host.idle();
  assert.equal(reports.includes("compression-model-mismatch"), false, "压缩器绑定的是本轮快照里的备用模型,不能按联系人原模型判失配");
  assert.equal(reqs[0]?.contact.speakingModel, backup);
});
