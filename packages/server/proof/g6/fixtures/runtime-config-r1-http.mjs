// PR #96 的真实 loopback HTTP 验收（需网络回环权限；不属于禁网 seatbelt 的窄测试）。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { mkItem, mkSet } from "./build.ts";
import { standinReply } from "../standin.ts";

const TOKEN = "NEUTRAL_FIXTURE_NO_CREDENTIALS";
const MODEL = "fixture-model";
const repo = realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../.."));

const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]);

test("C96-R1-05-HTTP 真正 runner CLI 经子进程与宿主把 65536 送到对话及检查 HTTP,manifest 保留完整预算", { timeout: 120_000 }, async () => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "gg-g6-cli-r1-")));
  const item = mkItem();
  const fixture = path.join(dir, "set.json");
  writeFileSync(fixture, JSON.stringify(mkSet([item])));
  const seen = [];
  const server = createServer(async (req, res) => {
    if (req.method === "GET") { res.writeHead(200); res.end("fixture"); return; }
    const chunks = [];
    for await (const data of req) chunks.push(Buffer.from(data));
    const text = Buffer.concat(chunks).toString("utf8");
    seen.push({ body: JSON.parse(text), key: req.headers["x-api-key"] });
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(standinReply(item, text));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  let child;
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const out = path.join(dir, "out");
    const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`, ANTHROPIC_API_KEY: TOKEN, GG_SPEAKING_MAX_OUTPUT_TOKENS: "65536", GG_SPEAKING_CONTEXT_WINDOW: "983010" };
    const args = [path.join(repo, "packages/server/proof/g6/run.ts"), "--mode=real", "--groups=g1", "--base=HEAD", `--models=${MODEL}`, "--items=T", "--reps=1", `--fixture=${fixture}`, `--out=${out}`, "--quiet=5", "--settle=0", "--step-timeout=5000", "--call-timeout=5000"];
    child = spawn(process.execPath, args, { cwd: repo, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let log = "";
    child.stdout.on("data", (d) => { log += d.toString(); });
    child.stderr.on("data", (d) => { log += d.toString(); });
    const timer = setTimeout(() => { if (child?.pid && child.exitCode === null) process.kill(-child.pid, "SIGTERM"); }, 100_000);
    const exit = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    clearTimeout(timer);
    assert.deepEqual(exit, { code: 0, signal: null }, log);
    const summary = JSON.parse(readFileSync(path.join(out, "summary.json"), "utf8"));
    assert.deepEqual(summary.models[0]?.speaking, { GG_SPEAKING_MAX_OUTPUT_TOKENS: "65536", GG_SPEAKING_CONTEXT_WINDOW: "983010" });
    const files = walk(path.join(out, "raw")).filter((file) => file.endsWith(".json"));
    assert.equal(files.length, 1, log);
    const raw = JSON.parse(readFileSync(files[0], "utf8"));
    assert.equal(raw.status, "ok", raw.error ?? log);
    const dialogue = raw.calls.filter((call) => call.cls === "round");
    const checks = raw.calls.filter((call) => call.cls === "check");
    assert.ok(dialogue.length > 0 && checks.length > 0, "真实宿主必须发对话与检查两类请求");
    assert.ok([...dialogue, ...checks].every((call) => call.maxTokens === 65536));
    assert.equal(seen.length, raw.calls.length);
    assert.ok(seen.length > 0 && seen.every((request) => request.body.max_tokens === 65536 && request.key === TOKEN));
  } finally {
    if (child?.pid && child.exitCode === null && child.signalCode === null) process.kill(-child.pid, "SIGTERM");
    server.closeAllConnections();
    await new Promise((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
