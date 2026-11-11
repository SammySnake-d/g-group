// 打包后的桌面应用:主进程起宿主时,Compute 用哪个 claude 命令、汇报工具(report_progress MCP)用什么命令起,
// 要能由启动方给定——图形界面启动的应用拿不到登录 shell 的 PATH,汇报脚本也随应用放在资源目录里,
// 包内按 import.meta.url 推出来的默认路径在打包后不存在。
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { claudeAdapterOptions } from "./compute.ts";
import { startServer } from "./start.ts";

const dir = mkdtempSync(path.join(tmpdir(), "gg-compute-cmd-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const NEUTRAL = { ANTHROPIC_BASE_URL: "http://127.0.0.1:9/neutral", ANTHROPIC_AUTH_TOKEN: "NEUTRAL_FIXTURE_NO_CREDENTIALS" };
const REPORT = { command: "/usr/bin/env", args: ["ELECTRON_RUN_AS_NODE=1", "/opt/neutral/g-group", "/opt/neutral/report-mcp.cjs"] };

test("Compute 适配器选项带上启动方给定的 claude 命令与汇报工具命令", () => {
  const runner = { command: "/opt/neutral/bin/claude" };
  assert.deepEqual(claudeAdapterOptions(NEUTRAL, 5_000, { runner, reportServer: REPORT }), {
    hostEnv: { ANTHROPIC_BASE_URL: "http://127.0.0.1:9/neutral", ANTHROPIC_AUTH_TOKEN: "NEUTRAL_FIXTURE_NO_CREDENTIALS" },
    idleReclaimMs: 5_000,
    runner,
    reportServer: REPORT,
  });
  assert.deepEqual(claudeAdapterOptions(NEUTRAL, 5_000, {}), { hostEnv: NEUTRAL, idleReclaimMs: 5_000 }, "没给命令时保持原样,用适配器默认值");
});

test("startServer 的 computeCommands:派活时真的用给定的 claude 命令起 Compute,汇报工具按给定命令写进 MCP 配置", async () => {
  const marker = path.join(dir, "runner.json");
  const fake = path.join(dir, "fake-claude.mjs");
  writeFileSync(
    fake,
    `import fs from "node:fs";
const i = process.argv.indexOf("--mcp-config");
const cfg = i > 0 ? JSON.parse(fs.readFileSync(process.argv[i + 1], "utf8")) : null;
fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ computeId: process.env.G_GROUP_COMPUTE_ID ?? null, host: cfg?.mcpServers?.host ?? null }));
process.exit(0);
`,
  );
  const s = await startServer({ dataDir: path.join(dir, "d1"), mind: "fake", compute: "claude", env: NEUTRAL, computeCommands: { runner: { command: process.execPath, args: [fake] }, reportServer: REPORT } });
  try {
    const c = s.host.createContact({ name: "小克" });
    const dm = s.host.openDm(c.id);
    s.host.send({ roomId: dm.id, clientActionId: "u1", text: "帮我写 hello.txt" });
    for (let i = 0; i < 200 && !existsSync(marker); i++) await new Promise((r) => setTimeout(r, 25));
    assert.ok(existsSync(marker), "给定的 claude 命令被拉起");
    const got = JSON.parse(readFileSync(marker, "utf8")) as { computeId: string | null; host: unknown };
    assert.deepEqual(got.host, { command: REPORT.command, args: REPORT.args, env: {} }, "汇报工具按给定命令启动");
    const [task] = s.host.listTasks({ contactId: c.id });
    assert.equal(got.computeId, task?.computeRuns[0]?.computeId, "被拉起的就是这件任务的 Compute");
  } finally {
    await s.close();
  }
});
