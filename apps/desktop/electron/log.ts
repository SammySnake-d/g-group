import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

let file: string | null = null;
export function initLog(userData: string) {
  const dir = path.join(userData, "logs");
  mkdirSync(dir, { recursive: true });
  file = path.join(dir, "main.log");
}
export function log(line: string) {
  const s = `${new Date().toISOString()} ${line}`;
  console.log(`[g-group] ${line}`);
  if (!file) return;
  try {
    appendFileSync(file, `${s}\n`);
  } catch {
    /* 写日志失败不影响运行 */
  }
}
