// 单点故障校准；每个候选必须先通过原样对照，再由指定行为测试以断言失败杀死。
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../../../..", import.meta.url));
const output = process.argv[2] ?? path.join(repo, "room-pending-summary-mutations-result.json");
const source = "packages/server/src/room-blocked-summary.ts";
const host = "packages/server/src/host.ts";
const tests = "packages/server/src/room-blocked-summary.test.ts";
const cases = [
  ["排序反向", source, "a.seq - b.seq", "b.seq - a.seq", "阻塞摘要按最早消息顺序选择并给出其余项数量"],
  ["漏其余项计数", source, 'ordered.length > 1 ? `（另有 ${ordered.length - 1} 项）` : ""', '""', "阻塞摘要按最早消息顺序选择并给出其余项数量"],
  ["空态造摘要", source, "if (!first) return null;", 'if (!first) return "等待你";', "没有阻塞时不给出虚构摘要"],
  ["保留换行", source, 'first.text.replace(/\\s+/g, " ").trim()', "first.text.trim()", "阻塞摘要折为一行并限制为合同允许的长度"],
  ["不截长文", source, 'return line.length <= 500 ? line : `${line.slice(0, 499)}…`;', "return line;", "阻塞摘要折为一行并限制为合同允许的长度"],
  ["未接实际原因", host, "text }];", 'text: "缺失原因" }];', "rooms.get 返回真实阻塞原因且读取不改变任务与已读游标"],
  ["删除会话范围", host, 'const roomTasks = listDocs<TaskDoc>(this.db, "task:").filter((d) => d.value.roomId === roomId);', 'const roomTasks = listDocs<TaskDoc>(this.db, "task:");', "其他会话没有本会话的阻塞摘要"],
  ["未接房间输出", host, "blockedSummary: roomBlockedSummary(blockers),", "blockedSummary: null,", "rooms.get 返回真实阻塞原因且读取不改变任务与已读游标"],
];
const temp = mkdtempSync(path.join(os.tmpdir(), "gg-room-summary-mut-"));
const root = path.join(temp, "repo");
mkdirSync(root);
const results = [];
try {
  const tar = execFileSync("git", ["archive", "HEAD"], { cwd: repo, maxBuffer: 128 * 1024 * 1024 });
  execFileSync("tar", ["-xf", "-", "-C", root], { input: tar });
  // 本片只改变 server；包入口都必须解析到此副本，不能链接回绿色工作树。
  mkdirSync(path.join(root, "node_modules/@g-group"), { recursive: true });
  const { readdirSync } = await import("node:fs");
  for (const entry of readdirSync(path.join(repo, "node_modules"))) {
    if (entry === "@g-group") continue;
    symlinkSync(path.join(repo, "node_modules", entry), path.join(root, "node_modules", entry));
  }
  for (const entry of readdirSync(path.join(repo, "node_modules/@g-group"))) {
    symlinkSync(path.join(root, "packages", entry), path.join(root, "node_modules/@g-group", entry));
  }
  function run() {
    const p = spawnSync(process.execPath, ["--test", "--test-reporter=tap", tests], { cwd: root, encoding: "utf8", timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
    const log = `${p.stdout ?? ""}${p.stderr ?? ""}`;
    const failed = [...log.matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1]);
    return { exit: p.status, error: p.error?.message ?? null, failed, assertion: log.includes("ERR_ASSERTION"), complete: /^# tests 7$/m.test(log) && /^# skipped 0$/m.test(log), log };
  }
  const control = run();
  writeFileSync(`${output}.control.tap`, control.log);
  if (control.exit !== 0 || !control.complete) throw new Error("原样对照未完整通过，禁止判变异");
  for (const [name, file, from, to, testName] of cases) {
    const target = path.join(root, file);
    const original = readFileSync(target, "utf8");
    if (original.split(from).length !== 2) throw new Error(`${name} 替换位置不唯一`);
    try {
      writeFileSync(target, original.replace(from, to));
      const actual = run();
      writeFileSync(`${output}.${results.length + 1}.tap`, actual.log);
      const killed = actual.exit === 1 && actual.complete && actual.assertion && actual.failed.includes(testName);
      results.push({ name, target_test: testName, killed, ...actual, log: undefined });
      console.log(JSON.stringify(results.at(-1)));
    } finally { writeFileSync(target, original); }
  }
  const receipt = { head: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim(), control: { tests: 7, pass: 7 }, total: results.length, killed: results.filter((r) => r.killed).length, results };
  writeFileSync(output, `${JSON.stringify(receipt, null, 2)}\n`);
  if (receipt.killed !== receipt.total) process.exitCode = 1;
} finally { rmSync(temp, { recursive: true, force: true }); }
