import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ROOT } from "./governance-files.ts";

interface Options { rootDir?: string; timeoutMs?: number }

function errorCode(error: unknown) {
  return (error as NodeJS.ErrnoException).code;
}

function isPidAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (errorCode(error) === "ESRCH") return false;
    if (errorCode(error) === "EPERM") return true;
    throw error;
  }
}

function removeOwnedLock(lockDir: string, owner: string) {
  // Only the process that unlinks this acquisition's unique marker removes the directory.
  try {
    fs.unlinkSync(path.join(lockDir, owner));
  } catch (error) {
    if (errorCode(error) === "ENOENT") return;
    throw error;
  }
  fs.rmdirSync(lockDir);
}

export async function acquireSuiteLock(label: string, opts: Options = {}) {
  const lockDir = path.join(opts.rootDir ?? ROOT, ".suite.lock");
  const owner = `${process.pid}-${randomUUID()}`;
  const deadline = Date.now() + (opts.timeoutMs ?? 300_000);
  while (true) {
    try {
      fs.mkdirSync(lockDir);
      break;
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }
    let markers: string[];
    try {
      markers = fs.readdirSync(lockDir);
    } catch (error) {
      if (errorCode(error) === "ENOENT") continue;
      throw error;
    }
    const marker = markers.length === 1 ? markers[0] : undefined;
    const pid = Number(marker?.match(/^([1-9]\d*)-[\da-f-]{36}$/)?.[1]);
    if (marker && Number.isSafeInteger(pid) && !isPidAlive(pid)) {
      removeOwnedLock(lockDir, marker);
      continue;
    }
    if (Date.now() >= deadline) {
      const detail = marker ? `owner ${marker}` : "owner marker absent; inspect the directory before clearing it";
      throw new Error(`Timed out waiting for ${lockDir} (${detail})`);
    }
    await delay(250);
  }

  try {
    fs.writeFileSync(path.join(lockDir, owner), label, { flag: "wx" });
  } catch (error) {
    fs.rmdirSync(lockDir);
    throw error;
  }

  const release = () => {
    process.off("exit", release);
    removeOwnedLock(lockDir, owner);
  };
  process.once("exit", release);
  return release;
}

async function main() {
  const args = process.argv.slice(2);
  const separator = args.indexOf("--");
  const label = separator > 0 ? args.slice(0, separator).join(" ") : "suite-run";
  const [command, ...commandArgs] = separator < 0 ? args : args.slice(separator + 1);
  if (!command) {
    console.error("Usage: node scripts/suite-lock.ts <label> -- <command> [args...]");
    process.exitCode = 2;
    return;
  }

  const release = await acquireSuiteLock(label);
  try {
    const child = spawn(command, commandArgs, { stdio: "inherit" });
    const interrupt = () => child.kill("SIGINT");
    const terminate = () => child.kill("SIGTERM");
    process.on("SIGINT", interrupt);
    process.on("SIGTERM", terminate);
    try {
      process.exitCode = await new Promise<number>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => resolve(code ?? (signal === "SIGINT" ? 130 : 143)));
      });
    } finally {
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", terminate);
    }
  } finally {
    release();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
