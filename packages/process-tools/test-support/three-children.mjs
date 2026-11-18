import { spawn } from "node:child_process";
const pids = [];
let ready = 0;
for (let i = 0; i < 3; i++) {
  const child = spawn(process.execPath, ["-e", 'process.on("SIGTERM", () => {}); process.send({ ready: true }); setInterval(() => {}, 1000);'], { detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"] });
  pids.push(child.pid);
  child.on("message", () => { if (++ready === 3) process.stdout.write(`${JSON.stringify({ pids })}\n`); });
}
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);
