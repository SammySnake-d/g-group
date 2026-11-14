// Owned neutral process fixture; intentionally leaves its setsid child for shared cleanup.
import { spawn } from "node:child_process";
import fs from "node:fs";
const child = spawn(process.execPath, ["-e", 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);'], { detached: true, stdio: "ignore" });
fs.writeFileSync(process.env.Q08_PID_FILE, JSON.stringify({ main: process.pid, descendant: child.pid }));
await import("../test-support/fake-claude-resident.mjs");
