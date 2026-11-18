// Owned neutral fixture: the main leaves a setsid child D (ignores SIGTERM); D starts a further setsid child G only when the
// test sends it SIGUSR2, i.e. after the cleanup handle already captured the tree. Each pid is relayed to stdout as one JSON line.
import { spawn } from "node:child_process";
const grandchild = 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);';
const middle = `process.on("SIGTERM", () => {});
process.on("SIGUSR2", () => { const g = require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(grandchild)}], { detached: true, stdio: "ignore" }); process.send({ g: g.pid }); });
process.send({ d: process.pid });
setInterval(() => {}, 1000);`;
const d = spawn(process.execPath, ["-e", middle], { detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"] });
d.on("message", (m) => process.stdout.write(`${JSON.stringify(m)}\n`));
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);
