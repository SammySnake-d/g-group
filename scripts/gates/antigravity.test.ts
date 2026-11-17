// Antigravity / codex-cli 来源门禁、逐轮模型绑定、规范化沙箱根与 merge.sh 动态基座保护单元测试。
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  agyBrainRoot,
  agyConversationsRoot,
  agyPluginDataRoot,
  agyRecoverStepModels,
  agyStepsToTurns,
  canonicalProvenanceRoots,
  codexCliRolloutToTurns,
  codexCliSessionsRoot,
  HARNESSES,
  loadSession,
  stripCodexExecWrapper,
  stripRunCommandWrapper,
  turnTouchesRepo,
} from "./gates.ts";
import { GIT_SAFE_ARGS, gitEnv } from "./lib.ts";
import { vendorOf } from "./vendor.ts";

const { DatabaseSync: SqliteDb } = createRequire(import.meta.url)("node:sqlite") as { DatabaseSync: typeof DatabaseSync };

function inTemp(body: (dir: string) => void) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-agy-test-"));
  try { body(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test("stripRunCommandWrapper 仅在退出码为 0 时剥离单层与双重 Created At 包装头并规范化 \\r\\n", () => {
  const single = "Created At: 2026-11-18T02:00:00+08:00\nCompleted At: 2026-11-18T02:00:01+08:00\nCommand exited with code 0.\n\nCommand output:\nabc123\n";
  assert.equal(stripRunCommandWrapper(single), "abc123\n");

  const dupCrLf = [
    "Created At: 2026-11-18T02:00:00+08:00",
    "Completed At: 2026-11-18T02:00:01+08:00",
    "Created At: 2026-11-18T02:00:00+08:00",
    "Completed At: 2026-11-18T02:00:01+08:00",
    "Command exited with code 0.",
    "",
    "Command output:",
    "line1",
    "line2",
    "",
  ].join("\r\n");
  assert.equal(stripRunCommandWrapper(dupCrLf), "line1\nline2\n");

  const nonZero = "Created At: 2026-11-18T02:00:00+08:00\nCompleted At: 2026-11-18T02:00:01+08:00\nCommand exited with code 1.\n\nCommand output:\nabc123\n";
  assert.equal(stripRunCommandWrapper(nonZero), nonZero);
});

test("agyStepsToTurns 按位置配对多工具调用并按 step_index 逐轮绑定模型,未匹配轮次保持 undefined 不涂抹", () => {
  const stepModels = new Map<number, string>([[1, "gemini-4-carbon-high"]]);
  const lines = [
    JSON.stringify({ step_index: 0, type: "SYSTEM_MESSAGE", content: "brief" }),
    JSON.stringify({
      step_index: 1,
      type: "PLANNER_RESPONSE",
      tool_calls: [
        { name: "edit_file", args: { Path: "/tmp/repo/a.ts", Target: "x", Replacement: "y" } },
        { name: "run_command", args: { CommandLine: "node scripts/gates/run-all.ts --hash --branch=feat/x --base=main" } },
      ],
    }),
    JSON.stringify({ step_index: 2, type: "GENERIC", content: "Created At: t0\nCompleted At: t1\nEdited file" }),
    JSON.stringify({ step_index: 3, type: "GENERIC", content: "Created At: t0\r\nCompleted At: t1\r\nCreated At: t0\r\nCompleted At: t1\r\nCommand exited with code 0.\r\n\r\nCommand output:\r\ndeadbeef\r\n" }),
    JSON.stringify({
      step_index: 4,
      type: "PLANNER_RESPONSE",
      tool_calls: [{ name: "run_command", args: { CommandLine: "true" } }],
    }),
  ];
  const turns = agyStepsToTurns(lines, stepModels);
  assert.equal(turns.length, 2);
  assert.equal(turns[0]?.model, "gemini-4-carbon-high");
  assert.equal(turns[0]?.toolCalls?.length, 2);
  assert.deepEqual(turns[0]?.toolCalls?.[1]?.input, {
    CommandLine: "node scripts/gates/run-all.ts --hash --branch=feat/x --base=main",
    command: "node scripts/gates/run-all.ts --hash --branch=feat/x --base=main",
  });
  assert.equal(turns[0]?.toolCalls?.[1]?.result, "deadbeef\n");
  assert.equal(turns[1]?.model, undefined);
});

test("agyRecoverStepModels 只取每行末尾 2KB trailer 抗 >20KB 前缀污染,并从活跃 WAL 恢复逐轮 step_index -> model", () => inTemp((dir) => {
  const conv = path.join(dir, "conversations");
  fs.mkdirSync(conv, { recursive: true });

  const dbPath = path.join(conv, "sess-1.db");
  const writer = new SqliteDb(dbPath);
  try {
    writer.exec("PRAGMA journal_mode = WAL; CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB);");
    // idx=10:前部 >20KB 大 prompt 污染(含对向厂商模型与 MODEL_PLACEHOLDER_),末尾 2KB trailer 为 last_step_index=1 + gemini-4-carbon-high
    const pollutedPrefix = `${"p".repeat(20_000)}last_step_index:1 MODEL_PLACEHOLDER_M999 claude-opus-4-6-thinking`;
    const cleanTrailer = `${"t".repeat(2100)}last_step_index\x12\x011\x1a\x16MODEL_PLACEHOLDER_M427 gemini-4-carbon-high`;
    writer.prepare("INSERT INTO gen_metadata (idx, data) VALUES (?, ?)").run(10, Buffer.from(pollutedPrefix + cleanTrailer, "latin1"));
    // idx=20:紧凑但无 MODEL_PLACEHOLDER_ 的干扰行
    writer.prepare("INSERT INTO gen_metadata (idx, data) VALUES (?, ?)").run(20, Buffer.from("last_step_index\x12\x011 brief claude-opus-4-6-thinking"));

    const m1 = agyRecoverStepModels(conv, "sess-1");
    assert.equal(m1.get(2), "gemini-4-carbon-high");
    assert.equal(vendorOf(m1.get(2)), "google");

    // 活跃 WAL 未 checkpoint 新帧:last_step_index=4 -> step_index=5 换模为 gpt-oss-120b-medium
    writer.exec("PRAGMA wal_autocheckpoint = 0;");
    writer.prepare("INSERT INTO gen_metadata (idx, data) VALUES (?, ?)").run(30, Buffer.from("last_step_index\x12\x014 MODEL_PLACEHOLDER_M500 gpt-oss-120b-medium"));
    const m2 = agyRecoverStepModels(conv, "sess-1");
    assert.equal(m2.get(2), "gemini-4-carbon-high");
    assert.equal(m2.get(5), "gpt-oss-120b-medium");
    assert.equal(vendorOf(m2.get(5)), "openai");
    assert.equal(vendorOf("gemini-pro-orchestrator"), "google");
    assert.equal(vendorOf("gemini-pro-orchestrator-argon"), "google");
    assert.equal(vendorOf("gemini-4-hydrogen-xhigh"), "google");
    assert.equal(vendorOf("claude-opus-4-6-thinking"), "anthropic");
  } finally {
    writer.close();
  }
}));

test("loadSession 支持 antigravity 逐轮换模保留、未匹配轮次保持 unknown、派生根共享与软链逃逸拦截", () => inTemp((dir) => {
  const store = path.join(dir, "agy-store");
  const brain = path.join(store, "brain");
  const conv = path.join(store, "conversations");
  const savedBrain = process.env.AGY_BRAIN_ROOT;
  const savedConv = process.env.AGY_CONV_ROOT;
  process.env.AGY_BRAIN_ROOT = brain;
  delete process.env.AGY_CONV_ROOT;
  try {
    fs.mkdirSync(brain, { recursive: true });
    fs.mkdirSync(conv, { recursive: true });
    assert.ok(HARNESSES.includes("antigravity"));
    assert.equal(agyBrainRoot(), brain);
    assert.equal(agyConversationsRoot(), path.join(fs.realpathSync(store), "conversations"));
    assert.equal(agyPluginDataRoot(), path.join(fs.realpathSync(store), "plugin_data"));
    assert.ok(canonicalProvenanceRoots().includes(agyConversationsRoot()));

    const log1 = path.join(brain, "u-switch", ".system_generated", "logs");
    fs.mkdirSync(log1, { recursive: true });
    fs.writeFileSync(
      path.join(log1, "transcript.jsonl"),
      `${[
        JSON.stringify({ step_index: 2, type: "PLANNER_RESPONSE", tool_calls: [{ name: "write_file", args: { Path: "/tmp/a.ts" } }] }),
        JSON.stringify({ step_index: 5, type: "PLANNER_RESPONSE", tool_calls: [{ name: "edit_file", args: { Path: "/tmp/a.ts" } }] }),
        JSON.stringify({ step_index: 8, type: "PLANNER_RESPONSE", tool_calls: [{ name: "run_command", args: { CommandLine: "true" } }] }),
      ].join("\n")}\n`,
    );
    const db = new SqliteDb(path.join(conv, "u-switch.db"));
    try {
      db.exec("CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB);");
      db.prepare("INSERT INTO gen_metadata (idx, data) VALUES (?, ?)").run(1, Buffer.from("last_step_index\x12\x011 MODEL_PLACEHOLDER_M1 claude-opus-4-6-thinking"));
      db.prepare("INSERT INTO gen_metadata (idx, data) VALUES (?, ?)").run(2, Buffer.from("last_step_index\x12\x014 MODEL_PLACEHOLDER_M2 gemini-4-carbon-high"));
    } finally {
      db.close();
    }
    const ok = loadSession(path.join(dir, "unused"), "antigravity:u-switch");
    assert.equal(ok.ok, true);
    if (ok.ok) {
      assert.equal(ok.turns[0]?.model, "claude-opus-4-6-thinking");
      assert.equal(ok.turns[1]?.model, "gemini-4-carbon-high");
      assert.equal(ok.turns[2]?.model, undefined);
    }

    const outside = path.join(dir, "outside.jsonl");
    fs.writeFileSync(outside, `${JSON.stringify({ step_index: 0, type: "PLANNER_RESPONSE", tool_calls: [{ name: "run_command", args: { CommandLine: "true" } }] })}\n`);
    const log2 = path.join(brain, "u-escape", ".system_generated", "logs");
    fs.mkdirSync(log2, { recursive: true });
    fs.symlinkSync(outside, path.join(log2, "transcript_full.jsonl"));
    const esc = loadSession(path.join(dir, "unused"), "antigravity:u-escape");
    assert.equal(esc.ok, false);
    if (!esc.ok) assert.match(esc.why, /brain 根目录之外/);
  } finally {
    if (savedBrain === undefined) delete process.env.AGY_BRAIN_ROOT;
    else process.env.AGY_BRAIN_ROOT = savedBrain;
    if (savedConv === undefined) delete process.env.AGY_CONV_ROOT;
    else process.env.AGY_CONV_ROOT = savedConv;
  }
}));

test("turnTouchesRepo 识别 edit_file/run_command 与大写 Path/TargetFile,并对无路径写调用保守计入", () => {
  const repo = "/tmp/fake-repo";
  const inRepo = (abs: string) => abs === repo || abs.startsWith(`${repo}/`);

  assert.equal(
    turnTouchesRepo({ toolCalls: [{ name: "edit_file", input: { Path: "../fake-repo/src/a.ts", cwd: "/tmp/other" } }] }, undefined, inRepo),
    true,
  );
  assert.equal(
    turnTouchesRepo({ toolCalls: [{ name: "write_file", input: { TargetFile: "../fake-repo/src/b.ts", cwd: "/tmp/other" } }] }, undefined, inRepo),
    true,
  );
  assert.equal(
    turnTouchesRepo({ toolCalls: [{ name: "edit_file", input: { Path: "../elsewhere/src/a.ts", cwd: "/tmp/other" } }] }, undefined, inRepo),
    false,
  );
  assert.equal(
    turnTouchesRepo({ toolCalls: [{ name: "edit_file", input: { Target: "old", Replacement: "new" } }] }, undefined, inRepo),
    true,
  );
  assert.equal(
    turnTouchesRepo({ toolCalls: [{ name: "run_command", input: { command: "npm test" } }] }, undefined, inRepo),
    true,
  );
});

test("stripCodexExecWrapper 仅在退出码为 0 时剥离完整与精简包装头并规范化 \\r\\n", () => {
  const full = "Chunk ID: d1cb98\nWall time: 0.0123 seconds\nProcess exited with code 0\nOriginal token count: 16\nOutput:\ndeadbeef\n";
  assert.equal(stripCodexExecWrapper(full), "deadbeef\n");

  const minimalCrLf = "Wall time: 0.05 seconds\r\nProcess exited with code 0\r\nOutput:\r\ncafebabe\r\n";
  assert.equal(stripCodexExecWrapper(minimalCrLf), "cafebabe\n");

  const nonZero = "Chunk ID: d1cb98\nWall time: 0.0123 seconds\nProcess exited with code 2\nOutput:\ndeadbeef\n";
  assert.equal(stripCodexExecWrapper(nonZero), nonZero);
});

test("codexCliRolloutToTurns 与 loadSession 支持日期目录检索、session_meta 身份核对与软链逃逸拦截", () => inTemp((dir) => {
  const cliRoot = path.join(dir, "codex-sessions");
  const saved = process.env.CODEX_CLI_SESSIONS_ROOT;
  process.env.CODEX_CLI_SESSIONS_ROOT = cliRoot;
  try {
    assert.ok(HARNESSES.includes("codex-cli"));
    assert.equal(codexCliSessionsRoot(), cliRoot);
    assert.equal(vendorOf("fnqtz-gpt/gpt-6.1-terra"), "openai");
    assert.equal(vendorOf("fnqtz-gpt/gpt-6.1-sol"), "openai");
    assert.equal(vendorOf("shayu/gpt-6.2-sol"), "openai");

    const dayDir = path.join(cliRoot, "2026", "11", "18");
    fs.mkdirSync(dayDir, { recursive: true });
    const rolloutLines = [
      JSON.stringify({ type: "session_meta", payload: { id: "01a1eb09-0001", cwd: "/initial" } }),
      JSON.stringify({ type: "turn_context", payload: { model: "fnqtz-gpt/gpt-6.1-terra", cwd: "/repo-a" } }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "function_call",
          name: "exec_command",
          call_id: "call_hash",
          arguments: JSON.stringify({ cmd: "node scripts/gates/run-all.ts --hash --branch=feat/x --base=main" }),
        },
      }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "call_hash",
          output: [
            { type: "input_text", text: "Chunk ID: ab12cd\nWall time: 0.0200 seconds\nProcess exited with code 0\nOriginal token count: 16\nOutput:" },
            { type: "input_text", text: "hash1234" },
          ],
        },
      }),
      JSON.stringify({ type: "event_msg", payload: { type: "thread_settings_applied", thread_settings: { model: "fnqtz-gpt/gpt-6.1-sol", cwd: "/repo-b" } } }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          name: "apply_patch",
          call_id: "call_patch",
          input: "*** Begin Patch\n*** Update File: packages/core/src/add.ts\n",
        },
      }),
    ];
    const parsed = codexCliRolloutToTurns(rolloutLines, "01a1eb09-0001");
    assert.equal(parsed.ok, true);
    if (parsed.ok) {
      assert.equal(parsed.workdir, "/initial");
      assert.equal(parsed.turns.length, 2);
      assert.equal(parsed.turns[0]?.model, "fnqtz-gpt/gpt-6.1-terra");
      assert.equal(parsed.turns[0]?.toolCalls?.[0]?.result, "hash1234");
      assert.equal(parsed.turns[1]?.model, "fnqtz-gpt/gpt-6.1-sol");
    }

    const mismatch = codexCliRolloutToTurns(rolloutLines, "01a1eb09-other");
    assert.equal(mismatch.ok, false);
    if (!mismatch.ok) assert.match(mismatch.why, /session_meta id/);

    fs.writeFileSync(path.join(dayDir, "rollout-2026-11-18T03-43-44-01a1eb09-0001.jsonl"), `${rolloutLines.join("\n")}\n`);
    const ok = loadSession(path.join(dir, "unused"), "codex-cli:01a1eb09-0001");
    assert.equal(ok.ok, true);

    const outside = path.join(dir, "forged-rollout.jsonl");
    fs.writeFileSync(outside, `${rolloutLines.join("\n")}\n`);
    fs.symlinkSync(outside, path.join(dayDir, "rollout-2026-11-18T03-45-00-01a1eb09-escape.jsonl"));
    const esc = loadSession(path.join(dir, "unused"), "codex-cli:01a1eb09-escape");
    assert.equal(esc.ok, false);
    if (!esc.ok) assert.match(esc.why, /codex-cli 会话记录经软链指到了会话根目录之外/);
  } finally {
    if (saved === undefined) delete process.env.CODEX_CLI_SESSIONS_ROOT;
    else process.env.CODEX_CLI_SESSIONS_ROOT = saved;
  }
}));

test("scripts/merge.sh 动态基座分支保护查询区分 200(--required)、404 未保护(无 --required)与 500 故障(fail-closed)", () => inTemp((dir) => {
  const git = (cwd: string, ...args: string[]) => execFileSync("git", [...GIT_SAFE_ARGS, ...args], { cwd, encoding: "utf8", env: gitEnv() }).trim();
  const bare = path.join(dir, "origin.git");
  const repo = path.join(dir, "repo");
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bare, { recursive: true });
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  git(bare, "init", "--bare", "-q");
  git(repo, "init", "-qb", "dev/agy-backend");
  git(repo, "remote", "add", "origin", bare);
  fs.mkdirSync(path.join(repo, "scripts/gates"), { recursive: true });
  fs.copyFileSync(path.resolve(import.meta.dirname, "../merge.sh"), path.join(repo, "scripts/merge.sh"));
  fs.chmodSync(path.join(repo, "scripts/merge.sh"), 0o755);
  fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ name: "fixture", private: true, type: "module" }));
  fs.writeFileSync(path.join(repo, "scripts/gates/run-all.ts"), `console.log("CONTENT_HASH=" + "a".repeat(64));\n`);
  git(repo, "add", "-A");
  git(repo, "-c", "user.name=t", "-c", "user.email=t@e", "commit", "-qm", "base");
  git(repo, "push", "-q", "origin", "dev/agy-backend");
  git(repo, "checkout", "-qb", "feat/t");
  fs.writeFileSync(path.join(repo, "change.txt"), "1\n");
  git(repo, "add", "-A");
  git(repo, "-c", "user.name=t", "-c", "user.email=t@e", "commit", "-qm", "head");
  const headSha = git(repo, "rev-parse", "HEAD");
  git(repo, "push", "-q", "origin", "feat/t");

  fs.writeFileSync(path.join(bin, "npm"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const ghScript = `#!/usr/bin/env node
import fs from "node:fs";
const args = process.argv.slice(2);
fs.appendFileSync(process.env.MOCK_GH_LOG, JSON.stringify(args) + "\\n");
if (args[0] === "pr" && args[1] === "view") {
  if (args.includes("state")) console.log("MERGED");
  else console.log(${JSON.stringify(`feat/t ${headSha} dev/agy-backend`)});
  process.exit(0);
}
if (args[0] === "api" && args.includes("-i")) {
  const mode = process.env.MOCK_PROT_MODE;
  if (mode === "200") { console.log("HTTP/2.0 200 OK\\r\\n\\r\\n{}"); process.exit(0); }
  if (mode === "404") { console.log('HTTP/2.0 404 Not Found\\r\\n\\r\\n{"message":"Branch not protected"}'); process.exit(1); }
  console.log('HTTP/2.0 500 Internal Server Error\\r\\n\\r\\n{"message":"Internal Error"}'); process.exit(1);
}
process.exit(0);
`;
  fs.writeFileSync(path.join(bin, "gh"), ghScript, { mode: 0o755 });

  const runMerge = (mode: string) => {
    const logFile = path.join(dir, `gh-${mode}.log`);
    fs.writeFileSync(logFile, "");
    const r = spawnSync("/bin/bash", [path.join(repo, "scripts/merge.sh"), "12"], {
      cwd: repo,
      encoding: "utf8",
      env: { ...gitEnv(), PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`, MOCK_GH_LOG: logFile, MOCK_PROT_MODE: mode },
      timeout: 30_000,
    });
    const calls = fs.readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as string[]);
    return { status: r.status, out: (r.stdout ?? "") + (r.stderr ?? ""), calls };
  };

  const r200 = runMerge("200");
  assert.equal(r200.status, 0, r200.out);
  assert.ok(r200.calls.some((c) => c[0] === "pr" && c[1] === "checks" && c.includes("--required")));
  assert.ok(r200.calls.some((c) => c[0] === "pr" && c[1] === "merge"));

  const r404 = runMerge("404");
  assert.equal(r404.status, 0, r404.out);
  assert.ok(r404.calls.some((c) => c[0] === "pr" && c[1] === "checks" && !c.includes("--required")));
  assert.ok(r404.calls.some((c) => c[0] === "pr" && c[1] === "merge"));

  const r500 = runMerge("500");
  assert.equal(r500.status, 1, r500.out);
  assert.equal(r500.calls.some((c) => c[0] === "pr" && (c[1] === "checks" || c[1] === "merge")), false);
}));
