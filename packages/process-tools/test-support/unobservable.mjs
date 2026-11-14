import { spawn } from "node:child_process";
import { once } from "node:events";
import { createProcessCleanup } from "../src/cleanup.ts";
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
try {
  const cleanup = createProcessCleanup(child);
  cleanup.requestStop(20);
  const result = await cleanup.quiesce(1000, 1000);
  process.stdout.write(JSON.stringify(result));
} finally {
  if (child.pid !== undefined) { try { process.kill(-child.pid, "SIGKILL"); } catch {} }
  if (child.exitCode === null && child.signalCode === null) await once(child, "exit");
}
