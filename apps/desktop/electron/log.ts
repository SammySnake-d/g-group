// 主进程的事件日志:userData/logs/main.log。只记启动、后端起停与失败、退出、更新安装这类排障要用的事,不记聊天内容、不记令牌。
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
