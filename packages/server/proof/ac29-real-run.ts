// AC-29 真实运行:真实 Claude Code Compute + 规则替身联系人脑子;本机真实 HOME(看全局 skill 是否漏入)。
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createComputeAdapter } from "@g-group/adapter-cc-compute";
import { scriptedMind } from "../src/fakes.ts";
import { Host } from "../src/host.ts";

// 用法: node packages/server/proof/ac29-real-run.ts [数据目录,默认系统临时目录下 gg-ac29-real]
const D = process.argv[2] ?? path.join(os.tmpdir(), "gg-ac29-real");
const ECHO = fileURLToPath(new URL("./echo-mcp.mjs", import.meta.url));
fs.rmSync(D, { recursive: true, force: true });
const skill = (name: string, body: string) => {
  fs.mkdirSync(path.join(D, "library", "skills", name), { recursive: true });
  fs.writeFileSync(path.join(D, "library", "skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: ${body.split("\n")[0]}\n---\n${body}\n`);
};
skill("gg-proof-style", "写笔记的格式要求(中性样例)\n写任何笔记文件时,第一行必须是 STYLE: PICKED_SKILL_APPLIED,第二行起写正文。");
skill("gg-unpicked-style", "没被勾选的样例 skill\n第一行写 STYLE: UNPICKED_LEAKED。");
fs.mkdirSync(path.join(D, "library", "mcp"), { recursive: true });
fs.writeFileSync(path.join(D, "library", "mcp", "gg-echo.json"), JSON.stringify({ command: process.execPath, args: [ECHO] }));
fs.writeFileSync(path.join(D, "library", "mcp", "gg-unpicked.json"), JSON.stringify({ command: process.execPath, args: [ECHO] }));
const work = path.join(D, "work");
fs.mkdirSync(work, { recursive: true });

const model = process.env.ANTHROPIC_DEFAULT_SONNET_MODEL!;
const hostEnv: Record<string, string> = { ANTHROPIC_MODEL: model };
for (const k of ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"]) if (process.env[k]) hostEnv[k] = process.env[k]!;
const adapter = createComputeAdapter({ hostEnv });
const host = new Host({ file: path.join(D, "gg.db"), dataDir: D, mind: () => scriptedMind(), compute: () => adapter, computeCwd: (t) => { const d = path.join(work, t); fs.mkdirSync(d, { recursive: true }); return d; }, maxDeferMs: 50 });
const c = host.createContact({ name: "小克", speakingModel: model, computeModel: { mode: "explicit", model } });
host.updateContact(c.id, { computeAssets: [{ name: "gg-proof-style", kind: "skill" }, { name: "gg-echo", kind: "mcp" }] });
const dm = host.openDm(c.id);
const ask = "帮我先调用 gg-echo 服务器的 echo 工具回显 hello-iso,再按勾选的 skill gg-skills:gg-proof-style 的要求把回显结果写进当前目录的 note.md";
console.log(`# ${new Date().toISOString()} 真实 Claude Code Compute(${model}),联系人脑子为规则替身 scriptedMind;HOME 为本机真实 HOME`);
console.log(`# 能力库:skill gg-proof-style、gg-unpicked-style;MCP gg-echo、gg-unpicked。联系人只勾选 gg-proof-style 与 gg-echo`);
host.send({ roomId: dm.id, clientActionId: "u1", text: ask });
const t0 = Date.now();
for (;;) {
  await host.idle();
  const [t] = host.listTasks({ roomId: dm.id });
  if (t && ["T5_InReview", "T11_Failed", "T10_Cancelled"].includes(t.state)) break;
  if (Date.now() - t0 > 300_000) { console.log("# 超时 300 秒"); break; }
  await new Promise((r) => setTimeout(r, 1000));
}
await host.idle();
for (const m of host.listMessages(dm.id, {}).messages) console.log(`#${m.seq} ${m.sender.kind === "user" ? "我" : "小克"}: ${m.text}${m.card ? `  [卡片:${m.card.kind}]` : ""}`);
const [t] = host.listTasks({ roomId: dm.id });
console.log(`任务 ${t!.id} [${t!.state}] 进度=${t!.recentProgress.map((p) => p.kind).join(">")}`);
const run = t!.computeRuns[0]!;
console.log(`Compute ${run.computeId} 实际加载(CLI init 自报): ${JSON.stringify(run.loaded)}`);
const globalDir = path.join(os.homedir(), ".claude", "skills");
const globalNames = fs.existsSync(globalDir) ? fs.readdirSync(globalDir) : [];
const loadedNames = (run.loaded?.skills ?? []).map((s) => s.split(":").pop()!);
console.log(`本机 ~/.claude/skills 目录数 ${globalNames.length};与实际加载的交集: ${JSON.stringify(loadedNames.filter((n) => globalNames.includes(n)))}`);
console.log(`未勾选的库 skill/MCP 是否出现: ${JSON.stringify([...(run.loaded?.skills ?? []), ...(run.loaded?.mcpServers ?? [])].filter((x) => x.includes("unpicked")))}`);
const note = path.join(work, t!.id, "note.md");
console.log(`note.md: ${fs.existsSync(note) ? JSON.stringify(fs.readFileSync(note, "utf8")) : "(没有)"}`);
const home = path.join(D, "run_homes", c.id, "claude-code");
console.log(`运行目录 ${path.relative(D, home)}: ${execFileSync("find", [".", "-maxdepth", "3", "-not", "-path", "./config/*"], { cwd: home, encoding: "utf8" }).trim().split("\n").sort().join(" ")}`);
console.log(`config 目录(CLAUDE_CONFIG_DIR)里 CLI 写下的会话记录: ${execFileSync("find", ["config", "-name", "*.jsonl"], { cwd: home, encoding: "utf8" }).trim().split("\n").filter(Boolean).length} 个`);
await host.close();
process.exit(0);
