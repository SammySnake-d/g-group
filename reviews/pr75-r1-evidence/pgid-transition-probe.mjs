// 独立审查复现：只写中性标记文件，两个 Python 进程均自行退出，不发真实停止信号。
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repo = process.argv[2];
const { treeNow, confirmStopped } = await import(pathToFileURL(path.join(repo, 'packages/adapter-cc-compute/src/stop-confirm.ts')));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr75-neutral-pgid-'));
const delay = ms => new Promise(r => setTimeout(r, ms));
async function until(pred, name) {
  const end = Date.now() + 8000;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`等待超时：${name}`);
    await delay(10);
  }
}
const childCode = `import os,sys,time,pathlib
d=pathlib.Path(sys.argv[1])
(d/'child.pid').write_text(str(os.getpid()))
deadline=time.time()+10
while not (d/'release').exists() and time.time()<deadline: time.sleep(.01)
os.setsid()
(d/'detached').write_text('NEUTRAL_FIXTURE_NO_CREDENTIALS')
while not (d/'finish').exists() and time.time()<deadline: time.sleep(.01)
(d/'child-exited').write_text('NEUTRAL_FIXTURE_NO_CREDENTIALS')
`;
const parentCode = `import sys,time,pathlib,subprocess
d=pathlib.Path(sys.argv[1])
subprocess.Popen([sys.executable,'-c',sys.argv[2],str(d)],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
deadline=time.time()+10
while not (d/'release').exists() and time.time()<deadline: time.sleep(.01)
`;
const p = spawn('python3', ['-c', parentCode, dir, childCode], { detached: true, stdio: 'ignore' });
const parentExit = new Promise(r => p.once('exit', (code, signal) => r({ code, signal })));
const originalKill = process.kill;
let child;
const signals = [];
try {
  await until(() => fs.existsSync(path.join(dir, 'child.pid')), '中性子进程就绪');
  child = Number(fs.readFileSync(path.join(dir, 'child.pid'), 'utf8'));
  const before = treeNow(p.pid);
  if (!before?.some(r => r.pid === child && r.pgid === p.pid)) throw new Error('停止前快照未捕获同组子进程');
  fs.writeFileSync(path.join(dir, 'release'), 'NEUTRAL_FIXTURE_NO_CREDENTIALS');
  const parentResult = await parentExit;
  await until(() => fs.existsSync(path.join(dir, 'detached')), '子进程自然脱组');
  const after = execFileSync('ps', ['-p', String(child), '-o', 'pid=,ppid=,pgid=,stat='], { encoding: 'utf8' }).trim();
  // 即使待审函数尝试停止，也只记录中性标记，绝不真的 kill。
  process.kill = (pid, sig) => {
    if (sig === 0) return originalKill(pid, 0);
    signals.push({ pid, sig });
    fs.writeFileSync(path.join(dir, 'signal-attempt'), 'NEUTRAL_FIXTURE_NO_CREDENTIALS');
    return true;
  };
  const result = await confirmStopped(p.pid, before, 120);
  process.kill = originalKill;
  let alive = false;
  try { originalKill(child, 0); alive = true; } catch {}
  const defect = result.ok && alive && signals.length === 0;
  console.log(JSON.stringify({
    name: 'PR75-STOP-PGID：停止前可见的子进程随后 setsid，仍活着时不得确认已停止',
    root: p.pid, child, before, after, parentResult, result, aliveWhenConfirmed: alive,
    neutralSignalAttempts: signals, realStopSignalsSent: 0, defect,
  }, null, 2));
  process.exitCode = defect ? 1 : 0;
} finally {
  process.kill = originalKill;
  fs.writeFileSync(path.join(dir, 'finish'), 'NEUTRAL_FIXTURE_NO_CREDENTIALS');
  await until(() => fs.existsSync(path.join(dir, 'child-exited')), '子进程自行结束');
  fs.rmSync(dir, { recursive: true, force: true });
}
