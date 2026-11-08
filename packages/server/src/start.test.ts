// 一站式启动给 Electron 主进程:fake 模式不连模型也能跑通派活闭环;bind 挂到 ipcMain 后 invoke/subscribe 可用。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { type WebContentsLike, startServer } from "./index.ts";

const dir = mkdtempSync(path.join(tmpdir(), "gg-start-"));
after(() => rmSync(dir, { recursive: true, force: true }));

test("startServer(fake) + bindIpc:渲染进程经 gg:invoke 建联系人、私聊派活,经 gg:event 收到进度与交付", async () => {
  const s = await startServer({ dataDir: path.join(dir, "d1"), env: {} });
  const handlers = new Map<string, (e: { sender: WebContentsLike }, ...a: unknown[]) => unknown>();
  s.bind({ handle: (ch, fn) => handlers.set(ch, fn), on: (ch, fn) => handlers.set(ch, fn) });
  const events: { type: string }[] = [];
  const sender: WebContentsLike = { id: 1, send: (ch, ev) => ch === "gg:event" && events.push(ev as { type: string }), once: () => {} };
  const invoke = (method: string, params: unknown) => handlers.get("gg:invoke")!({ sender }, { method, params }) as Promise<{ ok: boolean; value?: { id: string } }>;
  handlers.get("gg:subscribe")!({ sender }, {});
  const c = await invoke("contacts.create", { clientActionId: "c", name: "小克" });
  const dm = await invoke("rooms.openDm", { contactId: c.value!.id });
  const sent = await invoke("messages.send", { roomId: dm.value!.id, clientActionId: "m", text: "帮我整理周报" });
  assert.ok(sent.ok);
  for (let i = 0; i < 100 && !events.some((e) => e.type === "task.updated" && (e as unknown as { task: { state: string } }).task.state === "T5_InReview"); i++) await new Promise((r) => setTimeout(r, 50));
  const types = new Set(events.map((e) => e.type));
  for (const t of ["contact.updated", "room.updated", "message.appended", "receipt.updated", "contact.activity", "task.updated", "compute.progress"]) assert.ok(types.has(t), `缺 ${t}`);
  const mk = await invoke("plugins.marketplace", {});
  assert.ok(mk.ok, "默认挂上示例市场");
  await s.close();
});
