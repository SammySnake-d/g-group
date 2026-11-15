// PR #75 第 2 轮独立探针(审查人 Claude)。真实 Python 进程,真实 SIGKILL(不拦截 process.kill)。
// 用法: node probe-r2.mjs <仓库绝对路径> <variant> [trials]
// 所有夹具进程自带 deadline(最长 25s 自行退出),只写本探针临时目录里的中性标记文件。
// 判据: confirmStopped 返回 ok:true 之后,夹具进程(停止前快照里有的,或它们的后代/同组成员)仍存活 → defect。
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [repo, variant, trialsArg] = process.argv.slice(2);
const trials = Number(trialsArg ?? 1);
const { treeNow, confirmStopped } = await import(pathToFileURL(path.join(repo, 'packages/adapter-cc-compute/src/stop-confirm.ts')));
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (pred, name, ms = 8000) => { const end = Date.now() + ms; while (!pred()) { if (Date.now() > end) throw new Error(`等待超时:${name}`); await delay(5); } };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const psRow = (pid) => { try { return execFileSync('ps', ['-p', String(pid), '-o', 'pid=,ppid=,pgid=,stat=,lstart='], { encoding: 'utf8' }).trim(); } catch { return null; } };

const HEAD = `import os,sys,time,pathlib,subprocess
d=pathlib.Path(sys.argv[1]); deadline=time.time()+25
def mark(n,v='NEUTRAL_FIXTURE_NO_CREDENTIALS'): (d/n).write_text(v)
def wait(n):
    while not (d/n).exists() and time.time()<deadline: time.sleep(.005)
def reg():
    with open(d/'pids','a') as f: f.write(str(os.getpid())+'\\n')
`;
// 叶子:登记 pid 后睡到 finish 或 deadline
const LEAF = HEAD + `reg(); wait('finish')\n`;
const CHILD = {
  // 快照后 setsid(第 1 轮 CORR-001 的原场景)
  setsid: HEAD + `reg(); mark('child.pid',str(os.getpid())); wait('release'); os.setsid(); mark('detached'); wait('finish')\n`,
  // 快照后 setpgid(0,0):换进程组但不换会话
  setpgid: HEAD + `reg(); mark('child.pid',str(os.getpid())); wait('release'); os.setpgid(0,0); mark('detached'); wait('finish')\n`,
  // 快照后 setsid,再起一个孙进程(孙进程不在停止前快照里,也不在 root 进程组里)
  'setsid-then-spawn': HEAD + `reg(); mark('child.pid',str(os.getpid())); wait('release'); os.setsid()
subprocess.Popen([sys.executable,'-c',sys.argv[2],str(d)],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
while not (d/'pids').read_text().count('\\n')>=2 and time.time()<deadline: time.sleep(.005)
mark('detached'); wait('finish')\n`,
  // 始终留在 root 进程组里,不停地起新的同组子进程(构建/测试运行器那类持续派生的负载)
  churn: HEAD + `reg(); mark('child.pid',str(os.getpid())); wait('release'); mark('detached')
while not (d/'finish').exists() and time.time()<deadline:
    subprocess.Popen([sys.executable,'-c',sys.argv[2],str(d)],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    time.sleep(float(os.environ.get('CHURN_GAP','0.004')))\n`,
  // 阴性对照:不换组、不派生,正常能被杀掉并确认
  plain: HEAD + `reg(); mark('child.pid',str(os.getpid())); wait('release'); mark('detached'); wait('finish')\n`,
};
const PARENT = `import sys,time,pathlib,subprocess
d=pathlib.Path(sys.argv[1]); deadline=time.time()+25
subprocess.Popen([sys.executable,'-c',sys.argv[2],str(d),sys.argv[3]],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
while not (d/'release').exists() and time.time()<deadline: time.sleep(.005)
`;
if (!CHILD[variant]) { console.error(`未知 variant ${variant}`); process.exit(2); }

const out = [];
for (let i = 0; i < trials; i++) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr75-r2-neutral-'));
  const p = spawn('python3', ['-c', PARENT, dir, CHILD[variant], LEAF], { detached: true, stdio: 'ignore' });
  const parentExit = new Promise((r) => p.once('exit', (code, signal) => r({ code, signal })));
  const rec = { variant, trial: i, root: p.pid };
  try {
    await until(() => { try { return /^\d+$/.test(fs.readFileSync(path.join(dir, 'child.pid'), 'utf8')); } catch { return false; } }, '子进程就绪');
    const child = Number(fs.readFileSync(path.join(dir, 'child.pid'), 'utf8'));
    const before = treeNow(p.pid);
    rec.child = child; rec.before = before;
    if (!before?.some((r) => r.pid === child && (r.pgid === p.pid || process.env.PROBE_NOPS === '1'))) throw new Error('停止前快照未捕获同组子进程'); // PROBE_NOPS:读不到 ps 时快照走 pgrep,进程组记 -1
    fs.writeFileSync(path.join(dir, 'release'), 'x');
    rec.parentResult = await parentExit;
    await until(() => fs.existsSync(path.join(dir, 'detached')), '子进程进入待测状态');
    if (variant === 'churn') await delay(60);
    rec.childRowBeforeConfirm = psRow(child);
    rec.result = await confirmStopped(p.pid, before, 1500);
    // 返回的那一刻立刻看:登记过的夹具进程谁还活着
    const pids = fs.readFileSync(path.join(dir, 'pids'), 'utf8').split('\n').filter(Boolean).map(Number);
    await delay(30); // 让刚被 SIGKILL 的进程从进程表消失、晚登记的 pid 落盘
    const pids2 = fs.readFileSync(path.join(dir, 'pids'), 'utf8').split('\n').filter(Boolean).map(Number);
    const survivors = [...new Set([...pids, ...pids2])].filter(alive);
    rec.registered = pids2.length;
    rec.survivors = survivors.map((pid) => ({ pid, row: psRow(pid), inBefore: before.some((r) => r.pid === pid) }));
    rec.childAlive = alive(child);
    rec.defect = rec.result.ok === true && survivors.length > 0;
  } catch (e) { rec.error = String(e); }
  finally {
    fs.writeFileSync(path.join(dir, 'release'), 'x');
    fs.writeFileSync(path.join(dir, 'finish'), 'x');
    await delay(150);
    // 收尾:夹具进程见到 finish 自行退出;仍在的(只可能是本探针登记过的 pid)再等 deadline,不额外发信号
    try {
      const pids = fs.readFileSync(path.join(dir, 'pids'), 'utf8').split('\n').filter(Boolean).map(Number);
      const end = Date.now() + 5000;
      while (pids.some(alive) && Date.now() < end) await delay(50);
      rec.leftAfterCleanup = pids.filter(alive).length;
    } catch { /* 没有登记文件 */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }
  out.push(rec);
}
const summary = { variant, trials, okTrue: out.filter((r) => r.result?.ok === true).length, okFalse: out.filter((r) => r.result?.ok === false).length, defects: out.filter((r) => r.defect).length, errors: out.filter((r) => r.error).length, survivorsTotal: out.reduce((n, r) => n + (r.survivors?.length ?? 0), 0) };
console.log(JSON.stringify({ summary, runs: out }, null, 1));
process.exitCode = summary.defects > 0 ? 1 : summary.errors > 0 ? 3 : 0;
