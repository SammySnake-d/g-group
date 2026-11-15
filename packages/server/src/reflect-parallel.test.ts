// 反思失败时，笔记后备与检查并行不能丢失回复或笔记；这是成本有额外代价的候选。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Host } from "./host.ts";

test("反思失败且本轮无笔记：补写先启动并与检查重叠，仍按原事务提交回复与笔记", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gg-b2-parallel-"));
  let resolveStarted!: () => void;
  const started = new Promise<void>((resolve) => { resolveStarted = resolve; });
  let releaseReflect!: () => void;
  const reflectGate = new Promise<void>((resolve) => { releaseReflect = resolve; });
  let compactCalls = 0;
  const reports: string[] = [];
  const host = new Host({
    file: path.join(dir, "gg.db"), dataDir: dir, maxDeferMs: 5,
    onReport: (what) => reports.push(what),
    mind: () => ({ async round(input) {
      const msg = input.fresh.find((f) => f.kind === "message");
      if (msg?.kind !== "message") throw new Error("缺新消息");
      return { actions: [{ kind: "reply", roomId: msg.roomId, text: "收到", replyToSeq: msg.seq }], stateNote: null };
    } }),
    compactor: () => ({
      concurrentReflectCompact: true,
      async reflect() { resolveStarted(); await reflectGate; throw new Error("格式错误"); },
      async compact() { compactCalls++; return "本轮状态笔记"; },
    }),
  });
  try {
    const c = host.createContact({ name: "小克", speakingModel: "test-model" });
    const dm = host.openDm(c.id);
    host.send({ roomId: dm.id, clientActionId: "test", text: "你好" });
    await started;
    const overlapped = compactCalls === 1;
    releaseReflect();
    for (let i = 0; i < 200; i++) {
      await host.idle();
      if (host.listMessages(dm.id, {}).messages.some((m) => m.sender.kind === "contact")) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(host.stateNote(c.id), "本轮状态笔记", "不能为减少等待丢掉笔记");
    assert.ok(host.listMessages(dm.id, {}).messages.some((m) => m.sender.kind === "contact" && m.text === "收到"));
    assert.ok(reports.includes("reflect-failed"), "检查失败仍如实报告");
    assert.equal(overlapped, true, "反思未结束时后备就已启动");
    assert.equal(compactCalls, 1, "同轮后备只启动一次");
  } finally {
    releaseReflect();
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("反思成功：保留其笔记、记忆和人格建议，取消推测性的补写", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gg-b2-reflect-ok-"));
  let compactCalls = 0;
  let compactAborted = false;
  const host = new Host({
    file: path.join(dir, "gg.db"), dataDir: dir, maxDeferMs: 5,
    mind: () => ({ async round(input) {
      const msg = input.fresh.find((f) => f.kind === "message");
      if (msg?.kind !== "message") throw new Error("缺新消息");
      return { actions: [{ kind: "reply", roomId: msg.roomId, text: "收到", replyToSeq: msg.seq }], stateNote: null };
    } }),
    compactor: () => ({
      concurrentReflectCompact: true,
      async reflect() { return { note: "反思写的笔记", memories: [{ title: "语言", text: "以后用中文", anchors: ["global"], relation: null, target: null }], personaSuggestion: "保持简洁" }; },
      async compact(_req, signal) {
        compactCalls++;
        return new Promise<string>((_resolve, reject) => {
          const abort = () => { compactAborted = true; reject(new Error("已中止")); };
          if (signal.aborted) abort();
          else signal.addEventListener("abort", abort, { once: true });
        });
      },
    }),
  });
  try {
    const c = host.createContact({ name: "小克", speakingModel: "test-model" });
    const dm = host.openDm(c.id);
    host.send({ roomId: dm.id, clientActionId: "test", text: "以后都用中文。" });
    for (let i = 0; i < 200; i++) {
      await host.idle();
      if (host.listMessages(dm.id, {}).messages.some((m) => m.sender.kind === "contact")) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(host.stateNote(c.id), "反思写的笔记");
    assert.ok(host.listMemories(c.id).some((m) => m.title === "语言"));
    assert.deepEqual(host.personaSuggestions(c.id), ["保持简洁"]);
    assert.equal(compactCalls, 1, "反思成功时可能有一次推测性额外调用");
    assert.equal(compactAborted, true, "成功后中止无用后备");
  } finally {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("模型本轮已有笔记：仍检查记忆，但不启动额外补写且不覆盖笔记", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gg-b2-already-written-"));
  let compactCalls = 0, reflectCalls = 0;
  const host = new Host({
    file: path.join(dir, "gg.db"), dataDir: dir, maxDeferMs: 5,
    mind: () => ({ async round(input) {
      const msg = input.fresh.find((f) => f.kind === "message");
      if (msg?.kind !== "message") throw new Error("缺新消息");
      return { actions: [{ kind: "reply", roomId: msg.roomId, text: "收到", replyToSeq: msg.seq }], stateNote: "模型自己的笔记" };
    } }),
    compactor: () => ({
      concurrentReflectCompact: true,
      async reflect(req) { reflectCalls++; assert.equal(req.noteWritten, "模型自己的笔记"); return { note: "不应覆盖", memories: [], personaSuggestion: null }; },
      async compact() { compactCalls++; return "不应调用"; },
    }),
  });
  try {
    const c = host.createContact({ name: "小克", speakingModel: "test-model" });
    const dm = host.openDm(c.id);
    host.send({ roomId: dm.id, clientActionId: "test", text: "你好" });
    for (let i = 0; i < 200; i++) {
      await host.idle();
      if (host.listMessages(dm.id, {}).messages.some((m) => m.sender.kind === "contact")) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(reflectCalls, 1);
    assert.equal(compactCalls, 0);
    assert.equal(host.stateNote(c.id), "模型自己的笔记");
  } finally {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("反思成功却未给笔记：仍须使用补写结果，不能把空笔记当完成", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gg-b2-null-note-"));
  let compactCalls = 0;
  const host = new Host({
    file: path.join(dir, "gg.db"), dataDir: dir, maxDeferMs: 5,
    mind: () => ({ async round(input) {
      const msg = input.fresh.find((f) => f.kind === "message");
      if (msg?.kind !== "message") throw new Error("缺新消息");
      return { actions: [{ kind: "reply", roomId: msg.roomId, text: "收到", replyToSeq: msg.seq }], stateNote: null };
    } }),
    compactor: () => ({
      concurrentReflectCompact: true,
      async reflect() { return { note: null, memories: [], personaSuggestion: null }; },
      async compact() { compactCalls++; return "补出的笔记"; },
    }),
  });
  try {
    const c = host.createContact({ name: "小克", speakingModel: "test-model" });
    const dm = host.openDm(c.id);
    host.send({ roomId: dm.id, clientActionId: "test", text: "你好" });
    for (let i = 0; i < 200; i++) {
      await host.idle();
      if (host.listMessages(dm.id, {}).messages.some((m) => m.sender.kind === "contact")) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(compactCalls, 1);
    assert.equal(host.stateNote(c.id), "补出的笔记");
  } finally {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("检查和补写都失败：保留旧笔记、照常回复并报告两个失败", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gg-b2-fail-both-"));
  const reports: string[] = [];
  let rounds = 0;
  const host = new Host({
    file: path.join(dir, "gg.db"), dataDir: dir, maxDeferMs: 5,
    onReport: (what) => reports.push(what),
    mind: () => ({ async round(input) {
      rounds++;
      const msg = input.fresh.find((f) => f.kind === "message");
      if (msg?.kind !== "message") throw new Error("缺新消息");
      return { actions: [{ kind: "reply", roomId: msg.roomId, text: `收到${rounds}`, replyToSeq: msg.seq }], stateNote: rounds === 1 ? "旧笔记" : null };
    } }),
    compactor: () => ({
      concurrentReflectCompact: true,
      async reflect(req) { if (req.noteWritten === null) throw new Error("检查失败"); return { note: null, memories: [], personaSuggestion: null }; },
      async compact() { throw new Error("补写失败"); },
    }),
  });
  try {
    const c = host.createContact({ name: "小克", speakingModel: "test-model" });
    const dm = host.openDm(c.id);
    for (const [id, text] of [["first", "第一句"], ["second", "第二句"]]) {
      host.send({ roomId: dm.id, clientActionId: id!, text: text! });
      for (let i = 0; i < 200; i++) {
        await host.idle();
        if (host.listMessages(dm.id, {}).messages.filter((m) => m.sender.kind === "contact").length >= (id === "first" ? 1 : 2)) break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }
    assert.equal(host.stateNote(c.id), "旧笔记");
    assert.ok(host.listMessages(dm.id, {}).messages.some((m) => m.sender.kind === "contact" && m.text === "收到2"));
    assert.ok(reports.includes("reflect-failed"));
    assert.ok(reports.includes("compact-failed"));
  } finally {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("并行后备等待检查期间发生撤回：最终笔记仍移除撤回原文", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gg-b2-retract-"));
  const original = "NEUTRAL_FIXTURE_RETRACTED_8397";
  let resolveStarted!: () => void;
  const started = new Promise<void>((resolve) => { resolveStarted = resolve; });
  let releaseReflect!: () => void;
  const gate = new Promise<void>((resolve) => { releaseReflect = resolve; });
  let waited = false;
  const host = new Host({
    file: path.join(dir, "gg.db"), dataDir: dir, maxDeferMs: 5,
    mind: () => ({ async round(input) {
      const msg = input.fresh.find((f) => f.kind === "message");
      return { actions: msg?.kind === "message" ? [{ kind: "reply", roomId: msg.roomId, text: "收到", replyToSeq: msg.seq }] : [], stateNote: null };
    } }),
    compactor: () => ({
      concurrentReflectCompact: true,
      async reflect() { if (!waited) { waited = true; resolveStarted(); await gate; } throw new Error("检查失败"); },
      async compact() { return `笔记：${original}`; },
    }),
  });
  try {
    const c = host.createContact({ name: "小克", speakingModel: "test-model" });
    const dm = host.openDm(c.id);
    const sent = host.send({ roomId: dm.id, clientActionId: "test", text: original });
    await started;
    host.retractMessage(dm.id, sent.seq);
    releaseReflect();
    for (let i = 0; i < 200; i++) {
      await host.idle();
      if (host.stateNote(c.id) !== null && !host.loop.busy()) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.notEqual(host.stateNote(c.id), null, "后备笔记仍完成");
    assert.doesNotMatch(host.stateNote(c.id)!, /NEUTRAL_FIXTURE_RETRACTED_8397/);
  } finally {
    releaseReflect();
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("压缩器未声明并发安全：保留串行检查与补写，不能强加并发", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gg-b2-serial-only-"));
  let resolveStarted!: () => void;
  const started = new Promise<void>((resolve) => { resolveStarted = resolve; });
  let releaseReflect!: () => void;
  const gate = new Promise<void>((resolve) => { releaseReflect = resolve; });
  let reflecting = false, overlap = false;
  const host = new Host({
    file: path.join(dir, "gg.db"), dataDir: dir, maxDeferMs: 5,
    mind: () => ({ async round(input) {
      const msg = input.fresh.find((f) => f.kind === "message");
      if (msg?.kind !== "message") throw new Error("缺新消息");
      return { actions: [{ kind: "reply", roomId: msg.roomId, text: "收到", replyToSeq: msg.seq }], stateNote: null };
    } }),
    compactor: () => ({
      async reflect() { reflecting = true; resolveStarted(); await gate; reflecting = false; throw new Error("检查失败"); },
      async compact() { overlap ||= reflecting; return "补写笔记"; },
    }),
  });
  try {
    const c = host.createContact({ name: "小克", speakingModel: "test-model" });
    const dm = host.openDm(c.id);
    host.send({ roomId: dm.id, clientActionId: "test", text: "你好" });
    await started;
    await new Promise((resolve) => setImmediate(resolve));
    releaseReflect();
    for (let i = 0; i < 200; i++) {
      await host.idle();
      if (host.listMessages(dm.id, {}).messages.some((m) => m.sender.kind === "contact")) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(host.stateNote(c.id), "补写笔记");
    assert.equal(overlap, false, "未承诺并发安全的实现仍须串行");
  } finally {
    releaseReflect();
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("宿主中止时两项在途请求都收到中止，未提交的回复不会落库", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gg-b2-close-"));
  let reflectStarted!: () => void, compactStarted!: () => void;
  const readyReflect = new Promise<void>((resolve) => { reflectStarted = resolve; });
  const readyCompact = new Promise<void>((resolve) => { compactStarted = resolve; });
  let reflectAborted = false, compactAborted = false;
  const host = new Host({
    file: path.join(dir, "gg.db"), dataDir: dir, maxDeferMs: 5,
    mind: () => ({ async round(input) {
      const msg = input.fresh.find((f) => f.kind === "message");
      if (msg?.kind !== "message") throw new Error("缺新消息");
      return { actions: [{ kind: "reply", roomId: msg.roomId, text: "不应提交", replyToSeq: msg.seq }], stateNote: null };
    } }),
    compactor: () => ({
      concurrentReflectCompact: true,
      async reflect(_req, signal) {
        reflectStarted();
        return new Promise<never>((_resolve, reject) => {
          const abort = () => { reflectAborted = true; reject(new Error("检查中止")); };
          if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
        });
      },
      async compact(_req, signal) {
        compactStarted();
        return new Promise<string>((_resolve, reject) => {
          const abort = () => { compactAborted = true; reject(new Error("补写中止")); };
          if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
        });
      },
    }),
  });
  try {
    const c = host.createContact({ name: "小克", speakingModel: "test-model" });
    const dm = host.openDm(c.id);
    host.send({ roomId: dm.id, clientActionId: "test", text: "你好" });
    await Promise.all([readyReflect, readyCompact]);
    await host.close();
    assert.equal(reflectAborted, true);
    assert.equal(compactAborted, true);
    const db = new DatabaseSync(path.join(dir, "gg.db"), { readOnly: true });
    try { assert.equal((db.prepare("SELECT count(*) AS n FROM events WHERE sender_kind = 'contact'").get() as { n: number }).n, 0); }
    finally { db.close(); }
  } finally {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("后备请求还在生成时原文被撤回：不能继续等它把撤回材料发给上游", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gg-b2-retract-in-flight-"));
  const original = "NEUTRAL_FIXTURE_RETRACTED_8397";
  let firstReflect!: () => void, firstCompact!: () => void;
  const reflectReady = new Promise<void>((resolve) => { firstReflect = resolve; });
  const compactReady = new Promise<void>((resolve) => { firstCompact = resolve; });
  let releaseReflect!: () => void, releaseCompact!: () => void;
  const reflectGate = new Promise<void>((resolve) => { releaseReflect = resolve; });
  const compactGate = new Promise<void>((resolve) => { releaseCompact = resolve; });
  let calls = 0, leakedAfterRetraction = false, retracted = false;
  const host = new Host({
    file: path.join(dir, "gg.db"), dataDir: dir, maxDeferMs: 5,
    mind: () => ({ async round(input) {
      const msg = input.fresh.find((f) => f.kind === "message");
      return { actions: msg?.kind === "message" ? [{ kind: "reply", roomId: msg.roomId, text: "收到", replyToSeq: msg.seq }] : [], stateNote: null };
    } }),
    compactor: () => ({
      concurrentReflectCompact: true,
      async reflect() { firstReflect(); await reflectGate; throw new Error("检查失败"); },
      async compact(req, signal) {
        calls++;
        if (calls === 1) {
          assert.ok(req.material.includes(original));
          firstCompact();
          await compactGate;
          leakedAfterRetraction = retracted && !signal.aborted;
        }
        return "笔记";
      },
    }),
  });
  try {
    const c = host.createContact({ name: "小克", speakingModel: "test-model" });
    const dm = host.openDm(c.id);
    const sent = host.send({ roomId: dm.id, clientActionId: "test", text: original });
    await Promise.all([reflectReady, compactReady]);
    host.retractMessage(dm.id, sent.seq);
    retracted = true;
    releaseCompact();
    releaseReflect();
    await host.idle();
    assert.equal(leakedAfterRetraction, false, "撤回后不得继续推测性发送撤回材料");
  } finally {
    releaseCompact();
    releaseReflect();
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("撤回的旧消息已出现在本轮旧笔记：也中止携带旧笔记的推测性补写", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gg-b2-retract-old-note-"));
  const original = "NEUTRAL_FIXTURE_OLD_NOTE_4826";
  let reflectStarted!: () => void, compactStarted!: () => void;
  const readyReflect = new Promise<void>((resolve) => { reflectStarted = resolve; });
  const readyCompact = new Promise<void>((resolve) => { compactStarted = resolve; });
  let releaseReflect!: () => void, releaseCompact!: () => void;
  const gateReflect = new Promise<void>((resolve) => { releaseReflect = resolve; });
  const gateCompact = new Promise<void>((resolve) => { releaseCompact = resolve; });
  let rounds = 0, compacts = 0, retracted = false, leaked = false;
  const host = new Host({
    file: path.join(dir, "gg.db"), dataDir: dir, maxDeferMs: 5,
    mind: () => ({ async round(input) {
      const msg = input.fresh.find((f) => f.kind === "message");
      rounds++;
      return { actions: msg?.kind === "message" ? [{ kind: "reply", roomId: msg.roomId, text: `收到${rounds}`, replyToSeq: msg.seq }] : [], stateNote: rounds === 1 ? `旧笔记：${original}` : null };
    } }),
    compactor: () => ({
      concurrentReflectCompact: true,
      async reflect(req) { if (req.noteWritten !== null) return { note: null, memories: [], personaSuggestion: null }; reflectStarted(); await gateReflect; throw new Error("检查失败"); },
      async compact(req, signal) {
        compacts++;
        if (compacts === 1) {
          assert.ok(req.previous?.includes(original));
          compactStarted();
          await gateCompact;
          leaked = retracted && !signal.aborted;
        }
        return "笔记";
      },
    }),
  });
  try {
    const c = host.createContact({ name: "小克", speakingModel: "test-model" });
    const dm = host.openDm(c.id);
    const first = host.send({ roomId: dm.id, clientActionId: "first", text: original });
    for (let i = 0; i < 200; i++) {
      await host.idle();
      if (host.listMessages(dm.id, {}).messages.some((m) => m.sender.kind === "contact")) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    host.send({ roomId: dm.id, clientActionId: "second", text: "继续" });
    await Promise.all([readyReflect, readyCompact]);
    host.retractMessage(dm.id, first.seq);
    retracted = true;
    releaseCompact(); releaseReflect();
    await host.idle();
    assert.equal(leaked, false, "旧笔记引用的原文撤回后也须中止请求");
  } finally {
    releaseCompact(); releaseReflect();
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("用户撤回了当前轮原文：即使检查返回原文也不得把它写成持久记忆", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gg-b2-retract-memory-"));
  const original = "以后都使用固定代号 NEUTRAL_FIXTURE_2718";
  let resolveStarted!: () => void, releaseReflect!: () => void;
  const started = new Promise<void>((resolve) => { resolveStarted = resolve; });
  const gate = new Promise<void>((resolve) => { releaseReflect = resolve; });
  let checked = false;
  const host = new Host({
    file: path.join(dir, "gg.db"), dataDir: dir, maxDeferMs: 5,
    mind: () => ({ async round(input) {
      const msg = input.fresh.find((f) => f.kind === "message");
      return { actions: msg?.kind === "message" ? [{ kind: "reply", roomId: msg.roomId, text: "收到", replyToSeq: msg.seq }] : [], stateNote: null };
    } }),
    compactor: () => ({
      concurrentReflectCompact: true,
      async reflect() {
        if (!checked) {
          checked = true; resolveStarted(); await gate;
          return { note: original, memories: [{ title: "代号", text: original, anchors: ["global"], relation: null, target: null }], personaSuggestion: null };
        }
        return { note: "已撤回", memories: [], personaSuggestion: null };
      },
      async compact() { return "安全笔记"; },
    }),
  });
  try {
    const c = host.createContact({ name: "小克", speakingModel: "test-model" });
    const dm = host.openDm(c.id);
    const sent = host.send({ roomId: dm.id, clientActionId: "test", text: original });
    await started;
    host.retractMessage(dm.id, sent.seq);
    releaseReflect();
    await host.idle();
    assert.equal(host.listMemories(c.id).some((m) => m.body.includes(original)), false, "撤回原文不能进入持久记忆");
  } finally {
    releaseReflect();
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("反思准备读取记忆失败：不得提前发出推测补写", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gg-b2-prepare-error-"));
  let reportError!: () => void;
  const observed = new Promise<void>((resolve) => { reportError = resolve; });
  let compactCalls = 0;
  let host!: Host;
  host = new Host({
    file: path.join(dir, "gg.db"), dataDir: dir, maxDeferMs: 5,
    onReport: (what) => { if (what.startsWith("attention:error:")) reportError(); },
    mind: () => ({ async round(input) {
      const msg = input.fresh.find((f) => f.kind === "message");
      if (msg?.kind !== "message") throw new Error("缺新消息");
      // 仅在主回合完成后模拟存储读取失败，不影响此前的上下文装配。
      const store = (host as unknown as { memory: { list: () => never } }).memory;
      store.list = () => { throw new Error("模拟读取记忆失败"); };
      return { actions: [{ kind: "reply", roomId: msg.roomId, text: "收到", replyToSeq: msg.seq }], stateNote: null };
    } }),
    compactor: () => ({
      concurrentReflectCompact: true,
      async reflect() { return { note: "不应调用", memories: [], personaSuggestion: null }; },
      async compact() { compactCalls++; return "不应调用"; },
    }),
  });
  try {
    const c = host.createContact({ name: "小克", speakingModel: "test-model" });
    const dm = host.openDm(c.id);
    host.send({ roomId: dm.id, clientActionId: "test", text: "测试" });
    await observed;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(compactCalls, 0, "准备失败时不能向上游发额外材料");
  } finally {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
