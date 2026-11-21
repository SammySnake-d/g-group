import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { ContactMind } from "@g-group/kernel";
import { Host } from "./host.ts";

test("群里点名另一人时未被点名者可直接发表有新信息的补充", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gg-supplement-"));
  let bystanderId = "";
  let received = false;
  const mind = (): ContactMind => ({
    async round(input) {
      const message = input.fresh.find((f) => f.kind === "message" && f.sender.kind === "user");
      if (input.contact.id === bystanderId && message?.kind === "message") {
        received = true;
        return { actions: [{ kind: "reply", roomId: message.roomId, text: "补充:切换前还需要准备回滚路径", replyToSeq: null }], stateNote: null };
      }
      return { actions: [], stateNote: null };
    },
  });
  const host = new Host({ file: path.join(dir, "test.db"), mind, maxDeferMs: 5 });
  try {
    const addressed = host.createContact({ name: "小林" });
    const bystander = host.createContact({ name: "小克" });
    bystanderId = bystander.id;
    const group = host.createGroup("项目群", [{ kind: "contact", id: addressed.id }, { kind: "contact", id: bystander.id }]);
    const user = host.send({ roomId: group.id, clientActionId: "mention", text: "小林,说一下切换方案", mentions: [{ id: addressed.id, source: "manual" }] });
    for (let i = 0; i < 100; i++) {
      await host.idle();
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (received && !host.loop.busy()) break;
    }
    assert.equal(received, true, "未被点名者仍收到消息");
    const reply = host.listMessages(group.id, {}).messages.find((m) => m.sender.kind === "contact" && m.sender.id === bystander.id && m.text === "补充:切换前还需要准备回滚路径");
    assert.ok(reply, "未被点名者的实质补充不应因点名被机械拒绝");
    assert.deepEqual(host.loopGuard.rootsOf(group.id, reply.seq), [`message:${group.id}:${user.seq}`]);
  } finally {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("未被点名者收到的群聊指引区分重复附和与有新信息的补充", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gg-supplement-guide-"));
  let bystanderId = "";
  let guidance = "";
  const freshBlocks = new Map<string, string>();
  const mind = (): ContactMind => ({
    async round(input) {
      if (input.contact.id === bystanderId) guidance = input.request.blocks.find((block) => block.block === 1)?.text ?? "";
      freshBlocks.set(input.contact.id, input.request.blocks.find((block) => block.block === 4)?.text ?? "");
      return { actions: [], stateNote: null };
    },
  });
  const host = new Host({ file: path.join(dir, "test.db"), mind, maxDeferMs: 5 });
  try {
    const addressed = host.createContact({ name: "小林" });
    const bystander = host.createContact({ name: "小克" });
    bystanderId = bystander.id;
    const group = host.createGroup("项目群", [{ kind: "contact", id: addressed.id }, { kind: "contact", id: bystander.id }]);
    const message = host.send({ roomId: group.id, clientActionId: "guide", text: "小林,说一下切换方案", mentions: [{ id: addressed.id, source: "manual" }] });
    for (let i = 0; i < 100 && !guidance; i++) {
      await host.idle();
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.deepEqual(message.mentions, [{ id: addressed.id, source: "manual" }]);
    assert.ok(Buffer.byteLength(guidance) < 4000);
    assert.ok(guidance.includes("没有新信息"), "上下文提示没有新信息时不要重复回应");
    assert.ok(guidance.includes("有新信息"), "上下文也提示有新信息时可补充");
    assert.match(freshBlocks.get(bystanderId) ?? "", new RegExp(`@收件人：${addressed.id}`));
    assert.match(freshBlocks.get(addressed.id) ?? "", new RegExp(`@收件人：${addressed.id}`));
  } finally {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("并发群回复在提交时发现别人已发言须复核,无新信息不重复且有新信息可补充", { timeout: 10_000 }, async () => {
  for (const supplement of [false, true]) {
    const dir = mkdtempSync(path.join(tmpdir(), "gg-group-recheck-"));
    let addressedId = "";
    let bystanderId = "";
    let roomId = "";
    let recheckedWithBoth = false;
    let releaseAddressedCompact!: () => void;
    const addressedCompact = new Promise<void>((resolve) => { releaseAddressedCompact = resolve; });
    let rendezvousError: Error | undefined;
    let enterCompaction!: () => void;
    const inCompaction = new Promise<void>((resolve) => { enterCompaction = resolve; });
    let host!: Host;
    const mind = (): ContactMind => ({
      async round(input) {
        const user = input.fresh.find((f) => f.kind === "message" && f.sender.kind === "user");
        const peer = input.fresh.find((f) => f.kind === "message" && f.sender.kind === "contact" && f.sender.id === addressedId);
        if (input.contact.id === addressedId && user) {
          await inCompaction;
          return { actions: [{ kind: "reply", roomId, text: "GRP_OK_2", replyToSeq: null }], stateNote: null };
        }
        if (input.contact.id === bystanderId && user) {
          if (peer) {
            recheckedWithBoth = true;
            return { actions: supplement ? [{ kind: "reply", roomId, text: "补充:切换前还需要回滚路径", replyToSeq: null }] : [], stateNote: null };
          }
          enterCompaction();
          const deadline = Date.now() + 200;
          try {
            while (!host.listMessages(roomId, {}).messages.some(m => m.sender.kind === "contact" && m.sender.id === addressedId && m.text === "GRP_OK_2")) {
              if (Date.now() >= deadline) {
                rendezvousError = new Error("被点名者回复未在后台压缩前先行落盘");
                throw rendezvousError;
              }
              await new Promise(resolve => setTimeout(resolve, 5));
            }
          } finally {
            releaseAddressedCompact();
          }
          return { actions: [{ kind: "reply", roomId, text: "GRP_OK_2", replyToSeq: null }], stateNote: null };
        }
        return { actions: [], stateNote: null };
      },
    });
    host = new Host({
      file: path.join(dir, "test.db"), mind, maxDeferMs: 5,
      compactor: (contact) => ({
        async compact() {
          if (contact.id === addressedId) await addressedCompact;
          return "";
        },
      }),
    });
    try {
      const addressed = host.createContact({ name: "小林" });
      const bystander = host.createContact({ name: "小克" });
      addressedId = addressed.id;
      bystanderId = bystander.id;
      roomId = host.createGroup("项目群", [{ kind: "contact", id: addressedId }, { kind: "contact", id: bystanderId }]).id;
      host.send({ roomId, clientActionId: "concurrent", text: "小林,请只回复 GRP_OK_2", mentions: [{ id: addressedId, source: "manual" }] });
      for (let i = 0; i < 400; i++) {
        await host.idle();
        await new Promise((resolve) => setTimeout(resolve, 5));
        if (!host.loop.busy()) break;
      }
      const replies = host.listMessages(roomId, {}).messages.filter((m) => m.sender.kind === "contact").map((m) => [m.sender.id, m.text]);
      if (rendezvousError) throw rendezvousError;
      assert.equal(recheckedWithBoth, true, "提交前新到的联系人消息须与原用户消息一同重新交给旁观者");
      assert.deepEqual(replies, supplement ? [[addressedId, "GRP_OK_2"], [bystanderId, "补充:切换前还需要回滚路径"]] : [[addressedId, "GRP_OK_2"]]);
    } finally {
      await host.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("结构化 @everyone 展开为当前成员,与逐个点名去重并立即唤醒;纯正文不升级注意级别", { timeout: 10_000 }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gg-everyone-"));
  const seen: [string, readonly string[]][] = [];
  const host = new Host({ file: path.join(dir, "test.db"), maxDeferMs: 30_000, mind: () => ({ async round(input) {
    for (const f of input.fresh) if (f.kind === "message" && f.text === "明确群发") seen.push([input.contact.id, f.mentions]);
    return { actions: [], stateNote: null };
  } }) });
  try {
    const a = host.createContact({ name: "甲" }), b = host.createContact({ name: "乙" });
    const group = host.createGroup("群发", [{ kind: "contact", id: a.id }, { kind: "contact", id: b.id }]);
    const plain = host.send({ roomId: group.id, clientActionId: "plain", text: "书写 @everyone 作为普通文本" });
    assert.deepEqual(plain.mentions, []);
    const addressed = host.send({ roomId: group.id, clientActionId: "all", text: "明确群发", mentions: [{ id: a.id, source: "manual" }, { id: "@everyone", source: "manual" }] });
    assert.deepEqual(addressed.mentions, [{ id: a.id, source: "manual" }, { id: b.id, source: "manual" }]);
    for (let i = 0; i < 100 && seen.length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepEqual(seen.sort(([x], [y]) => x.localeCompare(y)), [a.id, b.id].sort().map((id) => [id, [a.id, b.id]]));
  } finally { await host.close(); rmSync(dir, { recursive: true, force: true }); }
});
