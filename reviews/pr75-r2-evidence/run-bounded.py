#!/usr/bin/env python3
"""有上限地跑一条命令:自成进程组,超时整组 SIGKILL;原样输出落盘,另写 JSON(起止、退出码、是否超时)。
用法: run-bounded.py <秒> <日志> <结果json> <cwd> -- 命令..."""
import json, os, signal, subprocess, sys, time
limit, log, res, cwd = int(sys.argv[1]), sys.argv[2], sys.argv[3], sys.argv[4]
cmd = sys.argv[sys.argv.index("--") + 1:]
t0 = time.time(); timed_out = False
with open(log, "w") as f:
    p = subprocess.Popen(cmd, cwd=cwd, stdout=f, stderr=subprocess.STDOUT, start_new_session=True)
    try: rc = p.wait(timeout=limit)
    except subprocess.TimeoutExpired:
        timed_out = True
        try: os.killpg(p.pid, signal.SIGKILL)
        except ProcessLookupError: pass
        rc = p.wait()
json.dump({"cmd": cmd, "cwd": cwd, "started": time.strftime("%FT%TZ", time.gmtime(t0)), "seconds": round(time.time() - t0, 1), "limit_s": limit, "timed_out": timed_out, "exit": rc, "log_bytes": os.path.getsize(log)}, open(res, "w"), ensure_ascii=False, indent=1)
