// Startup admission pattern informed by OpenMausBot 613ed01fd, codex-process.ts (Apache-2.0).
const LIMIT = 2;
const QUEUE_LIMIT = 32;
let active = 0;
const queue: (() => void)[] = [];
export function startupSlot(timeoutMs: number): Promise<() => void> {
  return new Promise((resolve, reject) => {
    let timer: NodeJS.Timeout | undefined;
    const enter = () => {
      clearTimeout(timer); active++;
      let released = false;
      resolve(() => { if (released) return; released = true; active--; queue.shift()?.(); });
    };
    if (active < LIMIT) { enter(); return; }
    if (queue.length >= QUEUE_LIMIT) { reject(new Error("Codex startup queue full")); return; }
    queue.push(enter);
    timer = setTimeout(() => {
      const i = queue.indexOf(enter); if (i >= 0) queue.splice(i, 1);
      reject(new Error("Codex startup slot timeout"));
    }, timeoutMs);
  });
}
export const RPC_TIMEOUT_MS: Readonly<Record<string, number>> = Object.freeze({
  initialize: 15_000, "thread/start": 30_000, "thread/resume": 30_000,
  "turn/start": 30_000, "turn/steer": 10_000, "turn/interrupt": 10_000,
});
