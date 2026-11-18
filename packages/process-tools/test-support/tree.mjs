import { spawn } from "node:child_process";
if (process.argv[2] === "descendant") {
  process.on("SIGTERM", () => {});
  process.send({ pid: process.pid });
  setInterval(() => {}, 1000);
} else {
  const descendant = spawn(process.execPath, [import.meta.filename, "descendant"], { detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"] });
  descendant.on("message", (message) => process.stdout.write(`${JSON.stringify(message)}\n`));
  if (process.env.Q08_IGNORE_TERM === "1") process.on("SIGTERM", () => {});
  else process.on("SIGTERM", () => process.exit(0));
  setInterval(() => {}, 1000);
}
