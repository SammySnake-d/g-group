import { spawn } from "node:child_process";
import fs from "node:fs";
const child = spawn(process.execPath, ["-e", 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);'], { detached: true, stdio: "ignore" });
fs.appendFileSync(process.env.Q08_PIDS_LOG, `${JSON.stringify({ main: process.pid, descendant: child.pid })}\n`);
if (process.env.Q08_FAIL_RESULTS === "1") {
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...rest) => {
    const s = String(chunk);
    return write(s.includes('"type":"result"') ? s.replace('"subtype":"success"', '"subtype":"error_during_execution"').replace('"is_error":false', '"is_error":true') : s, ...rest);
  };
}
await import("./fake-claude-resident.mjs");
if (process.env.Q08_IGNORE_TERM === "1") {
  process.removeAllListeners("SIGTERM");
  process.on("SIGTERM", () => {});
}
