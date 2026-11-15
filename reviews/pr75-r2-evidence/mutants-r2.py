#!/usr/bin/env python3
"""PR #75 第 2 轮审查人自构单点故障(停止确认的身份核对),在隔离工作树里跑 quiesce / resident-quiesce 两个测试文件。
用法: python3 mutants-r2.py <变异工作树(HEAD 干净检出)> <输出目录>"""
import json, os, re, subprocess, sys
wt, out = sys.argv[1:3]; os.makedirs(out, exist_ok=True)
TESTS = ["packages/adapter-cc-compute/src/quiesce.test.ts", "packages/adapter-cc-compute/src/resident-quiesce.test.ts"]
P = "packages/adapter-cc-compute/src/procgroup.ts"; S = "packages/adapter-cc-compute/src/stop-confirm.ts"
MUTANTS = [
  ("MA-unknown-identity-as-gone", P, 'if (known.identity === null || now.identity === null) return "unknown";', 'if (known.identity === null || now.identity === null) return "gone";', "启动身份读不到时当成已退出"),
  ("MB-unreadable-table-as-empty", S, 'if (table === null) return { ok: false, reason: "读不到进程表,无法确认它启动的子进程都已退出", remaining: [...known.keys()] };', 'if (table === null) return { ok: true, killed: killed.size };', "确认循环里读不到进程表时当成都退出了"),
  ("MC-ignore-identity", P, 'return known.identity === now.identity ? "alive" : "gone";', 'return "alive";', "不比对启动身份(PID 复用会误杀)"),
  ("MD-pgid-again", P, 'return known.identity === now.identity ? "alive" : "gone";', 'return known.identity === now.identity && known.pgid === now.pgid ? "alive" : "gone";', "回到第 1 轮缺陷:进程组变了就当成退出"),
  ("ME-unknown-ignored-in-confirm", S, '    if (unknown.length) return { ok: false, reason: "无法核对进程启动身份,不能确认已停止", remaining: unknown.map((r) => r.pid) };\n', '', "确认循环忽略身份无法核对的进程"),
  ("MF-no-kill", S, 'for (const r of alive) { try { process.kill(r.pid, "SIGKILL"); killed.add(r.pid); } catch { /* 刚退出 */ } }', 'for (const r of alive) killed.add(r.pid);', "只记数不真的发 SIGKILL"),
  ("MG-zombie-alive", P, 'if (!now || now.stat.startsWith("Z")) return "gone";', 'if (!now) return "gone";', "僵尸进程当成还活着"),
]
def sh(a, cwd): return subprocess.run(a, cwd=cwd, capture_output=True, text=True)
def run(tag):
    r = sh(["node", "--test", *TESTS], wt); open(os.path.join(out, f"{tag}.tap"), "w").write(r.stdout + r.stderr)
    c = {k: int(m.group(1)) if (m := re.search(rf"^# {k} (\d+)$", r.stdout, re.M)) else None for k in ("tests", "pass", "fail", "cancelled", "skipped", "todo")}
    return {"exit": r.returncode, **c, "failed": re.findall(r"^not ok \d+ - (.*)$", r.stdout, re.M)}
assert sh(["git", "status", "--porcelain"], wt).stdout == ""
res = {"head": sh(["git", "rev-parse", "HEAD"], wt).stdout.strip(), "tests": TESTS, "clean": run("clean"), "mutants": []}
for mid, f, old, new, why in MUTANTS:
    p = os.path.join(wt, f); src = open(p).read(); n = src.count(old); rec = {"id": mid, "file": f, "why": why, "matches": n}
    if n != 1: rec["verdict"] = "INVALID"
    else:
        open(p, "w").write(src.replace(old, new))
        try:
            rec.update(run(mid)); rec["verdict"] = "KILLED" if rec["exit"] != 0 and rec["failed"] and rec["cancelled"] == 0 else "SURVIVED" if rec["exit"] == 0 else "INCONCLUSIVE"
        finally: sh(["git", "checkout", "--", f], wt)
    res["mutants"].append(rec); print(mid, rec["verdict"], rec.get("tests"), rec.get("fail"), [x[:40] for x in rec.get("failed", [])][:3], flush=True)
res["clean_after"] = run("clean-after")
json.dump(res, open(os.path.join(out, "results.json"), "w"), ensure_ascii=False, indent=1)
print("clean", res["clean"]["exit"], res["clean"]["tests"], res["clean"]["pass"], "| after", res["clean_after"]["exit"], res["clean_after"]["pass"])
