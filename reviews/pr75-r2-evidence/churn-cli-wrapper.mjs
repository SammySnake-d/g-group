// 假 CLI 的外包一层:先起一个留在 CLI 进程组里、持续派生同组子进程的中性负载,再原样执行仓库自带的 fake-claude.mjs。
// 负载与叶子进程只写 CHURN_DIR 里的中性文件,见到 finish 或 25 秒 deadline 自行退出。
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
const LEAF = `import os,sys,time,pathlib
d=pathlib.Path(sys.argv[1]); deadline=time.time()+25
with open(d/'pids','a') as f: f.write(str(os.getpid())+'\\n')
while not (d/'finish').exists() and time.time()<deadline: time.sleep(.005)`;
const CHURN = `import os,sys,time,pathlib,subprocess
d=pathlib.Path(sys.argv[1]); deadline=time.time()+25
with open(d/'pids','a') as f: f.write(str(os.getpid())+'\\n')
while not (d/'go').exists() and time.time()<deadline: time.sleep(.005)
while not (d/'finish').exists() and time.time()<deadline:
    subprocess.Popen([sys.executable,'-c',sys.argv[2],str(d)],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    time.sleep(float(os.environ.get('CHURN_GAP','0.015')))`;
spawn("python3", ["-c", CHURN, process.env.CHURN_DIR, LEAF], { stdio: "ignore" });
await import(pathToFileURL(process.env.CHURN_FAKE).href);
