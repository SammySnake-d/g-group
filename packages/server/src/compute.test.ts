// AC-51 接线:真实 Claude Code Compute 走常驻适配器(会话内按轮换模型),进程环境只带网关地址与令牌,模型不写进环境;
// 空闲会话按时回收(下一轮用同一会话 id 带这一轮的生效模型恢复),宿主关闭时把还活着的常驻会话一并停掉。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { CLAUDE_IDLE_RECLAIM_MS, claudeAdapterOptions, claudeCompute } from "./compute.ts";
import { scriptedCompute, scriptedMind } from "./fakes.ts";
import { Host } from "./host.ts";

const dir = mkdtempSync(path.join(tmpdir(), "gg-compute-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const NEUTRAL = { ANTHROPIC_BASE_URL: "http://127.0.0.1:9/neutral", ANTHROPIC_AUTH_TOKEN: "NEUTRAL_FIXTURE_NO_CREDENTIALS", ANTHROPIC_MODEL: "pinned-model", HOME: "/tmp/neutral-home" };

test("真实 Compute 的进程环境只带网关地址与令牌,不把模型写进环境;空闲会话按时回收", () => {
  assert.deepEqual(claudeAdapterOptions(NEUTRAL), {
    hostEnv: { ANTHROPIC_BASE_URL: "http://127.0.0.1:9/neutral", ANTHROPIC_AUTH_TOKEN: "NEUTRAL_FIXTURE_NO_CREDENTIALS" },
    idleReclaimMs: 600_000,
  });
  assert.equal(CLAUDE_IDLE_RECLAIM_MS, 600_000);
  assert.deepEqual(claudeAdapterOptions({ ANTHROPIC_API_KEY: "NEUTRAL_FIXTURE_NO_CREDENTIALS", ANTHROPIC_BASE_URL: undefined }, 5_000), { hostEnv: { ANTHROPIC_API_KEY: "NEUTRAL_FIXTURE_NO_CREDENTIALS" }, idleReclaimMs: 5_000 });
});

test("真实 Compute 用常驻适配器:声明会话内换模型能力、能插话;工厂收到的模型不固定进实例", () => {
  const make = claudeCompute(NEUTRAL);
  const a = make("model-a");
  const b = make("model-b");
  // 常驻适配器收专属配置目录与勾选的 skill/MCP(AC-29):宿主据此才把勾选能力交给它
  assert.deepEqual(a.capabilities, { inSessionModelSwitch: true, isolation: true });
  assert.deepEqual(b.capabilities, { inSessionModelSwitch: true, isolation: true });
  assert.equal(typeof a.steer, "function", "常驻会话支持往当前这一轮插话");
});

test("宿主关闭时停掉还活着的常驻会话:一轮做完(completed)进程仍在,也要停,不留后台进程", async () => {
  const compute = scriptedCompute({ script: (id) => [{ kind: "started", sessionId: "s-1", resumed: false }, { kind: "completed", result: `完成 ${id}` }] });
  const host = new Host({ file: path.join(dir, "c1.db"), mind: () => scriptedMind(), compute: () => compute.adapter, maxDeferMs: 5 });
  const c = host.createContact({ name: "小克" });
  const dm = host.openDm(c.id);
  host.send({ roomId: dm.id, clientActionId: "u1", text: "帮我整理资料" });
  for (let i = 0; i < 200 && !(compute.drained() && host.listTasks({ contactId: c.id })[0]?.computeRuns[0]?.status === "completed"); i++) await new Promise((r) => setTimeout(r, 5));
  const [t] = host.listTasks({ contactId: c.id });
  assert.equal(t?.computeRuns[0]?.status, "completed");
  await host.close();
  assert.deepEqual(compute.stopped, [compute.spawned[0]!.computeId], "关闭时把做完一轮、进程还活着的常驻会话停掉");
  compute.close();
});
