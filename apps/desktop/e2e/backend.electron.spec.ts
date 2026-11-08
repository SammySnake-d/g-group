import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

// 真实路径(窄):Electron 主进程里起 dev/integration 的宿主服务(@g-group/server,SQLite + 联系人注意循环 + Compute),
// 渲染层只经 window.gg 按接口合同调用——建联系人 → 开私聊 → 派活 → 联系人回话 → Compute 进度 → 交付卡,
// 外加事件流推送、slash 内置命令、插件市场。联系人脑子和 Compute 用宿主自带的规则替身(不连模型)。
const appDir = path.resolve(import.meta.dirname, "..");

test("接上宿主服务:私聊派活走完一圈,事件流推到渲染层", async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "gg-e2e-"));
  const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[0] !== "ELECTRON_RUN_AS_NODE" && typeof e[1] === "string"));
  const app = await electron.launch({ args: [appDir], cwd: appDir, env: { ...env, GG_BACKEND: "server", GG_DATA_DIR: dataDir, GG_MIND: "fake", GG_COMPUTE: "fake" } });
  try {
    const win = await app.firstWindow();
    await win.waitForLoadState("domcontentloaded");
    type R = { ok: boolean; value?: Record<string, unknown> & { [k: string]: unknown }; error?: { code: string; message: string } };
    const call = async (m: string, p: unknown): Promise<R> => win.evaluate(([m, p]) => (window as unknown as { gg: { invoke: (m: string, p: unknown) => Promise<R> } }).gg.invoke(m as string, p), [m, p] as const);
    const ok = async <T = Record<string, unknown>>(m: string, p: unknown): Promise<T> => {
      const r = await call(m, p);
      expect(r.error, `${m} 应成功`).toBeUndefined();
      return r.value as T;
    };

    const hello = await ok<{ apiVersion: string; userId: string }>("session.hello", { clientApiVersion: "0.1.0" });
    expect(hello.apiVersion).toMatch(/^0\./);
    // 界面探测到后端已连上
    await expect(win.getByTestId("backend-demo")).toHaveAttribute("data-mode", "connected");

    // 渲染层订阅事件流,收集推过来的事件
    await win.evaluate(() => {
      const w = window as unknown as { gg: { subscribe: (l: (e: { kind?: string; type?: string }) => void) => () => void }; __ev: unknown[] };
      w.__ev = [];
      w.gg.subscribe((e) => w.__ev.push(e));
    });

    const contact = await ok<{ id: string; name: string }>("contacts.create", { clientActionId: "e2e-c1", name: "小克" });
    expect(contact.name).toBe("小克");
    const room = await ok<{ id: string }>("rooms.openDm", { contactId: contact.id });
    const sent = await ok<{ seq: number }>("messages.send", { roomId: room.id, clientActionId: "e2e-m1", text: "帮我写 hello.txt" });
    expect(sent.seq).toBeGreaterThan(0);
    // 同一个 clientActionId 重发不重复入库
    const again = await ok<{ seq: number }>("messages.send", { roomId: room.id, clientActionId: "e2e-m1", text: "帮我写 hello.txt" });
    expect(again.seq).toBe(sent.seq);

    // 联系人回话、派出 Compute、Compute 跑完、联系人发交付卡
    await expect.poll(async () => {
      const list = await ok<{ messages: { sender: { kind: string }; text: string; card: { kind: string } | null }[] }>("messages.list", { roomId: room.id, limit: 100 });
      const tasks = await ok<{ tasks: { recentProgress: { kind: string }[] }[] }>("tasks.list", { roomId: room.id });
      return {
        reply: list.messages.some((m) => m.sender.kind === "contact" && m.text.includes("安排 Compute")),
        completed: tasks.tasks.some((t) => t.recentProgress.some((p) => p.kind === "completed")),
        delivery: list.messages.some((m) => m.card?.kind === "delivery"),
      };
    }, { timeout: 30_000 }).toEqual({ reply: true, completed: true, delivery: true });
    const tasks = await ok<{ tasks: { title: string; state: string; recentProgress: { kind: string }[] }[] }>("tasks.list", { roomId: room.id });
    expect(tasks.tasks).toHaveLength(1);
    expect(tasks.tasks[0]!.title).toContain("写 hello.txt");
    expect(tasks.tasks[0]!.recentProgress.map((p) => p.kind)).toEqual(expect.arrayContaining(["started", "completed"]));

    // 事件流确实推到了渲染层
    const evCount = await win.evaluate(() => (window as unknown as { __ev: unknown[] }).__ev.length);
    expect(evCount).toBeGreaterThan(3);

    // slash 内置命令、插件市场来自宿主
    const cmds = await ok<{ commands: { name: string; source: string }[] }>("commands.list", { roomId: room.id });
    expect(cmds.commands.filter((c) => c.source === "builtin").map((c) => c.name)).toEqual(expect.arrayContaining(["task", "remind", "stop"]));
    const market = await ok<{ entries: unknown[] }>("plugins.marketplace", {});
    expect(market.entries.length).toBeGreaterThan(0);

    // 宿主回包仍过合同校验;非法参数在主进程就被拦
    const bad = await call("messages.send", { roomId: room.id, text: "缺 clientActionId" });
    expect(bad.error?.code).toBe("invalid_params");
  } finally {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
