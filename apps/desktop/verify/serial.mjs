#!/usr/bin/env node
// 全机排队跑重活(e2e、埋雷):本机同时有十几个会话,用户 #1083 要求测试别把机器占满。
// 用法:node verify/serial.mjs <命令…>   例:node verify/serial.mjs npx playwright test --project=renderer
// - 锁是 $TMPDIR 下的目录 gg-desktop-e2e.lock(mkdir 原子),里面记持锁进程号;持锁进程已不在就当作陈旧锁清掉
// - 子命令退出(含 Ctrl-C / 被杀)后释放锁,并清掉这个工作副本里残留的 vite / electron 进程
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const lock = path.join(os.tmpdir(), "gg-desktop-e2e.lock");
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function acquire() {
  let told = false;
  for (;;) {
    try {
      fs.mkdirSync(lock);
      fs.writeFileSync(path.join(lock, "pid"), `${process.pid} ${root}\n`);
      return;
    } catch {
      const [pid, who] = (fs.readFileSync(path.join(lock, "pid"), "utf8").trim() || "0 ?").split(" ");
      if (!alive(Number(pid))) { fs.rmSync(lock, { recursive: true, force: true }); continue; }
      if (!told) { console.error(`[serial] 等别的测试跑完(${who})…`); told = true; }
      await sleep(3000);
    }
  }
}
const release = () => { try { if (fs.readFileSync(path.join(lock, "pid"), "utf8").startsWith(`${process.pid} `)) fs.rmSync(lock, { recursive: true, force: true }); } catch {} };

/** 清掉本工作副本残留的 vite / electron(只认命令行里带本目录的,别人的不动) */
function sweep() {
  let out = "";
  try { out = execFileSync("pgrep", ["-fl", "vite|electron"], { encoding: "utf8" }); } catch { return 0; }
  let n = 0;
  for (const line of out.split("\n")) {
    const pid = Number(line.split(" ")[0]);
    if (pid && pid !== process.pid && line.includes(root)) { try { process.kill(pid, "SIGTERM"); n++; } catch {} }
  }
  return n;
}

await acquire();
const [cmd, ...args] = process.argv.slice(2);
const child = spawn(cmd, args, { cwd: root, stdio: "inherit" });
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
child.on("exit", (code) => {
  const n = sweep();
  release();
  console.error(`[serial] 结束,清掉残留进程 ${n} 个`);
  process.exit(code ?? 1);
});
