// R2: reuse the original isolated, sequential mutation loop; full 17-test execution per candidate.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../../..", import.meta.url));
const output = process.argv[2] ?? path.join(repo, "room-pending-summary-mutations-result.json");
const tests = "packages/server/src/room-blocked-summary.test.ts";
const cases = [
  [
    "排序反向",
    "packages/server/src/room-blocked-summary.ts",
    "a.seq - b.seq",
    "b.seq - a.seq",
    "阻塞摘要按最早消息顺序选择并给出其余项数量"
  ],
  [
    "漏其余项计数",
    "packages/server/src/room-blocked-summary.ts",
    "ordered.length > 1 ? `（另有 ${ordered.length - 1} 项）` : \"\"",
    "\"\"",
    "阻塞摘要按最早消息顺序选择并给出其余项数量"
  ],
  [
    "空态造摘要",
    "packages/server/src/room-blocked-summary.ts",
    "if (!first) return null;",
    "if (!first) return \"等待你\";",
    "没有阻塞时不给出虚构摘要"
  ],
  [
    "保留换行",
    "packages/server/src/room-blocked-summary.ts",
    "first.text.replace(/\\s+/g, \" \").trim()",
    "first.text.trim()",
    "阻塞摘要折为一行并限制为合同允许的长度"
  ],
  [
    "不截长文",
    "packages/server/src/room-blocked-summary.ts",
    "if (line.length <= 500) return line;",
    "return line;",
    "阻塞摘要折为一行并限制为合同允许的长度"
  ],
  [
    "未接实际原因",
    "packages/server/src/host.ts",
    "return [{ taskId: d.task.id, seq: card.seq, text }];",
    "return [{ taskId: d.task.id, seq: card.seq, text: \"缺失原因\" }];",
    "rooms.get 返回真实阻塞原因且读取不改变任务与已读游标"
  ],
  [
    "删除会话范围",
    "packages/server/src/host.ts",
    "const roomTasks = listDocs<TaskDoc>(this.db, \"task:\").filter((d) => d.value.roomId === roomId);",
    "const roomTasks = listDocs<TaskDoc>(this.db, \"task:\");",
    "其他会话没有本会话的阻塞摘要"
  ],
  [
    "未接房间输出",
    "packages/server/src/host.ts",
    "blockedSummary: roomBlockedSummary(blockers),",
    "blockedSummary: null,",
    "rooms.get 返回真实阻塞原因且读取不改变任务与已读游标"
  ],
  [
    "R1宿主改取最新",
    "packages/server/src/host.ts",
    "seq: card.seq, text }];",
    "seq: -card.seq, text }];",
    "R2-01 宿主最早问题与另有一项在回答后切换为剩余问题"
  ],
  [
    "R5边界499",
    "packages/server/src/room-blocked-summary.ts",
    "if (line.length <= 500) return line;",
    "if (line.length <= 499) return line;",
    "R2-02b 整行恰500字符不截断"
  ],
  [
    "R6边界501",
    "packages/server/src/room-blocked-summary.ts",
    "if (line.length <= 500) return line;",
    "if (line.length <= 501) return line;",
    "R2-02c 整行501字符截为499加省略号"
  ],
  [
    "R7丢授权action",
    "packages/server/src/host.ts",
    "this.authzOf(d.task.id).value.requests.find((q) => q.qId === d.task.pendingQ!.qId)?.action ?? this.questionText(d.task.id, d.task.pendingQ.qId)",
    "this.questionText(d.task.id, d.task.pendingQ.qId)",
    "R2-03 授权提问摘要取真实授权请求action而不是不存在的needs"
  ],
  [
    "R3丢open过滤",
    "packages/server/src/host.ts",
    "if (card?.state !== \"open\") return [];",
    "if (!card) return [];",
    "R2-04b 取消后旧问题仍可见且保留pendingQ但过期卡不能生成摘要"
  ],
  [
    "R9单项也计其余",
    "packages/server/src/room-blocked-summary.ts",
    "ordered.length > 1",
    "ordered.length >= 1",
    "R2-01 宿主最早问题与另有一项在回答后切换为剩余问题"
  ],
  [
    "R10读取幂等写入",
    "packages/server/src/host.ts",
    "const readSeq = this.readSeq(roomId, { kind: \"user\", id: this.userId });",
    "run(this.db, \"INSERT INTO gg_read (room_id, kind, member_id, upto_seq, at) VALUES (?, ?, ?, ?, ?)\", roomId, \"user\", this.userId, this.lastSeq(roomId), this.now());\n    const readSeq = this.readSeq(roomId, { kind: \"user\", id: this.userId });",
    "R2-06 rooms.get不产生幂等数据库写入也不发送事件"
  ],
  [
    "R11不trim",
    "packages/server/src/room-blocked-summary.ts",
    "first.text.replace(/\\s+/g, \" \").trim()",
    "first.text.replace(/\\s+/g, \" \")",
    "阻塞摘要折为一行并限制为合同允许的长度"
  ],
  [
    "R1-05先拼后截吃尾注",
    "packages/server/src/room-blocked-summary.ts",
    "return `${prefix}${clipped}…${suffix}`;",
    "return `${line.slice(0, 499)}…`;",
    "R2-05 长问题截断保留另有 N 项尾注且整行不超过500"
  ],
  [
    "R1-07切开代理对",
    "packages/server/src/room-blocked-summary.ts",
    ".replace(/[\\uD800-\\uDBFF]$/u, \"\")",
    "",
    "R2-07 Unicode截断不留下孤立高代理码元"
  ]
];
const hash = (data) => createHash("sha256").update(data).digest("hex");
const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
execFileSync("git", ["diff", "--quiet"], { cwd: repo });
execFileSync("git", ["diff", "--cached", "--quiet"], { cwd: repo });
const expectedNames = [...readFileSync(path.join(repo, tests), "utf8").matchAll(/^test\("([^"]+)"/gm)].map((m) => m[1]);
if (!expectedNames.length || new Set(expectedNames).size !== expectedNames.length) throw new Error("empty or duplicate test inventory");
const frozen = Object.fromEntries([tests, ...new Set(cases.map((c) => c[1]))].map((name) => [name, hash(readFileSync(path.join(repo, name)))]));
const temp = mkdtempSync(path.join(os.tmpdir(), "gg-room-summary-mut-"));
const root = path.join(temp, "repo");
mkdirSync(root);
mkdirSync(path.dirname(output), { recursive: true });
const results = [];
try {
  const tar = execFileSync("git", ["archive", "HEAD"], { cwd: repo, maxBuffer: 128 * 1024 * 1024 });
  execFileSync("tar", ["-xf", "-", "-C", root], { input: tar });
  mkdirSync(path.join(root, "node_modules/@g-group"), { recursive: true });
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
    const named = [...log.matchAll(/^(?:not )?ok \d+ - (.+)$/gm)].map((m) => m[1]);
    const counts = Object.fromEntries(["tests", "pass", "fail", "skipped", "cancelled", "todo"].map((key) => [key, Number(new RegExp(`^# ${key} (\\d+)$`, "m").exec(log)?.[1] ?? -1)]));
    const assertionNames = [];
    const lines = log.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const start = /^not ok \d+ - (.+)$/.exec(lines[i]);
      if (!start) continue;
      let end = i + 1;
      while (end < lines.length && !/^(?:# Subtest:|(?:not )?ok \d+ - |1\.\.)/.test(lines[end])) end++;
      if (/^\s+code: ['"]ERR_ASSERTION['"]\s*$/m.test(lines.slice(i, end).join("\n"))) assertionNames.push(start[1]);
    }
    const complete = counts.tests === expectedNames.length && counts.pass + counts.fail === expectedNames.length && counts.skipped === 0 && counts.cancelled === 0 && counts.todo === 0 && named.length === expectedNames.length && expectedNames.every((n) => named.filter((x) => x === n).length === 1);
    return { exit: p.status, signal: p.signal, error: p.error?.message ?? null, counts, failed, assertion_names: assertionNames, complete, log };
  }
  const control = run();
  writeFileSync(`${output}.control.tap`, control.log);
  if (control.exit !== 0 || !control.complete || control.counts.fail !== 0) throw new Error("original control did not completely pass; no mutant verdicts");
  for (const [name, file, from, to, testName] of cases) {
    const target = path.join(root, file);
    const original = readFileSync(target, "utf8");
    if (original.split(from).length !== 2) throw new Error(`${name}: non-unique mutation anchor`);
    try {
      writeFileSync(target, original.replace(from, to));
      const actual = run();
      writeFileSync(`${output}.${results.length + 1}.tap`, actual.log);
      const killed = actual.exit === 1 && !actual.error && !actual.signal && actual.complete && actual.assertion_names.includes(testName);
      results.push({ name, source: file, target_test: testName, killed, collateral_failures: actual.failed.filter((n) => n !== testName), ...actual, log: undefined });
      console.log(JSON.stringify(results.at(-1)));
    } finally { writeFileSync(target, original); }
  }
  const unchanged = Object.entries(frozen).every(([name, value]) => hash(readFileSync(path.join(repo, name))) === value);
  const receipt = { head, node: process.version, runner_sha256: hash(readFileSync(fileURLToPath(import.meta.url))), expected_tests: expectedNames, control: { ...control, log: undefined }, frozen_sha256: frozen, source_unchanged: unchanged, total: results.length, killed: results.filter((r) => r.killed).length, results, excluded_review_faults: { R2_state: "redundant predicate removed with reachability proof", R4_visibility: "redundant predicate removed with reachability proof", R12_open_and_visibility: "visibility predicate no longer exists; remaining open guard independently calibrated", R8_same_seq_tie: "equivalent under room-local unique sequence, not claimed killed" } };
  writeFileSync(output, `${JSON.stringify(receipt, null, 2)}\n`);
  if (!unchanged || receipt.killed !== receipt.total) process.exitCode = 1;
} finally { rmSync(temp, { recursive: true, force: true }); }
