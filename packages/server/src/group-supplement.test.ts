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
    host.send({ roomId: group.id, clientActionId: "mention", text: "小林,说一下切换方案", mentions: [{ id: addressed.id, source: "manual" }] });
    for (let i = 0; i < 100; i++) {
      await host.idle();
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (received && !host.loop.busy()) break;
    }
    assert.equal(received, true, "未被点名者仍收到消息");
    assert.ok(host.listMessages(group.id, {}).messages.some((m) => m.sender.kind === "contact" && m.sender.id === bystander.id && m.text === "补充:切换前还需要准备回滚路径"), "未被点名者的实质补充不应因点名被机械拒绝");
  } finally {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("未被点名者收到的群聊指引区分重复附和与有新信息的补充", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gg-supplement-guide-"));
  let bystanderId = "";
  let guidance = "";
  const mind = (): ContactMind => ({
    async round(input) {
      if (input.contact.id === bystanderId) guidance = input.request.blocks.find((block) => block.block === 1)?.text ?? "";
      return { actions: [], stateNote: null };
    },
  });
  const host = new Host({ file: path.join(dir, "test.db"), mind, maxDeferMs: 5 });
  try {
    const addressed = host.createContact({ name: "小林" });
    const bystander = host.createContact({ name: "小克" });
    bystanderId = bystander.id;
    const group = host.createGroup("项目群", [{ kind: "contact", id: addressed.id }, { kind: "contact", id: bystander.id }]);
    host.send({ roomId: group.id, clientActionId: "guide", text: "小林,说一下切换方案", mentions: [{ id: addressed.id, source: "manual" }] });
    for (let i = 0; i < 100 && !guidance; i++) {
      await host.idle();
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(guidance.includes("没有新信息"), "上下文提示没有新信息时不要重复回应");
    assert.ok(guidance.includes("有新信息"), "上下文也提示有新信息时可补充");
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
    let firstCompaction = true;
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
          return { actions: [{ kind: "reply", roomId, text: "GRP_OK_2", replyToSeq: null }], stateNote: null };
        }
        return { actions: [], stateNote: null };
      },
    });
    host = new Host({
      file: path.join(dir, "test.db"), mind, maxDeferMs: 5,
      compactor: (contact) => ({
        async compact() {
          if (contact.id === bystanderId && firstCompaction) {
            firstCompaction = false;
            enterCompaction();
            for (let i = 0; i < 300; i++) {
              if (host.listMessages(roomId, {}).messages.some((m) => m.sender.kind === "contact" && m.sender.id === addressedId)) return "";
              await new Promise((resolve) => setTimeout(resolve, 5));
            }
            throw new Error("被点名者未在状态笔记整理期间发言");
          }
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
      assert.equal(recheckedWithBoth, true, "提交前新到的联系人消息须与原用户消息一同重新交给旁观者");
      assert.deepEqual(replies, supplement ? [[addressedId, "GRP_OK_2"], [bystanderId, "补充:切换前还需要回滚路径"]] : [[addressedId, "GRP_OK_2"]]);
    } finally {
      await host.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }
});
