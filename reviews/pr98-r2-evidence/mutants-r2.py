#!/usr/bin/env python3
"""PR #98 第 2 轮审查人自构单点故障(每个只替换一处源码),在隔离工作树里跑同一组测试文件。
用法: python3 mutants-r2.py <HEAD 克隆> <变异工作树> <输出目录>
变异工作树必须是 HEAD 的干净检出(本脚本每个变异前后都 git checkout 还原)。"""
import json, os, re, subprocess, sys

head, wt, out = sys.argv[1:4]
os.makedirs(out, exist_ok=True)
TESTS = ["packages/server/src/count-triggers.test.ts", "packages/adapter-pi-contact/src/commit-every-n.test.ts"]
H = "packages/server/src/host.ts"; C = "packages/server/src/count-triggers.ts"; R = "packages/server/src/chat-range.ts"
CLOSE = '          this.countTriggers.closeContactTx(m.id, roomId, "联系人已不在这个会话");\n'
CLOSE2 = '        this.countTriggers.closeContactTx(m.id, roomId, "联系人已不在这个会话");\n'
MUTANTS = [
  # (id, 文件, 原文, 替换, 说明)
  ("M1-omit-helper", R, 'if (m.retracted || m.sender.kind === "system") continue;', 'if (m.retracted || m.sender.kind === "system" || m.sender.kind === "helper") continue;', "第 1 轮 TEST-001 的存活故障:Helper 发言不计数"),
  ("M2-global-window-count", C, '"SELECT count(*) AS n FROM gg_count_windows WHERE trigger_id = ?", t.id)', '"SELECT count(*) AS n FROM gg_count_windows WHERE ? IS NOT NULL", t.id)', "第 1 轮 TEST-002 的存活故障:视图窗口数不按 trigger 过滤"),
  ("M3-no-close-on-remove", H, "        this.exits.finishTx(roomId, m.id);\n" + CLOSE2, "        this.exits.finishTx(roomId, m.id);\n", "直接移出时不关闭触发(回到第 1 轮 CORR-001)"),
  ("M4-no-close-on-leaving", H, "          this.exits.begin(roomId, m.id);\n" + CLOSE, "          this.exits.begin(roomId, m.id);\n", "带在途任务的「移出中」开始时不关闭触发"),
  ("M5-no-close-on-dissolve", H, 'if (ok) this.countTriggers.closeRoomTx(input.roomId, "会话已解散");', "", "解散时不即时关闭(可能与下一条 system 通知的惰性关闭等价)"),
  ("M6-close-contact-all-rooms", C, "WHERE contact_id = ? AND room_id = ? AND status = 'active'\", contactId, roomId)", "WHERE contact_id = ? AND ? IS NOT NULL AND status = 'active'\", contactId, roomId)", "移出一个群时把该联系人在别的群的触发也关掉"),
  ("M7-close-room-all-contacts", C, "WHERE contact_id = ? AND room_id = ? AND status = 'active'\", contactId, roomId)", "WHERE ? IS NOT NULL AND room_id = ? AND status = 'active'\", contactId, roomId)", "移出一个联系人时把同群别的联系人的触发也关掉"),
  ("M8-close-keeps-pending", C, "    run(this.d.db, \"UPDATE gg_count_windows SET status = 'cancelled', settled_at = ? WHERE trigger_id = ? AND status = 'pending'\", this.d.now(), t.id);\n", "", "关闭触发时不取消未处理窗口"),
  ("M9-close-reason-dropped", C, 'closeContactTx(contactId: string, roomId: string, reason: string): void {', 'closeContactTx(contactId: string, roomId: string, _r: string, reason = "x"): void {', "移出关闭不写明原因"),
]

def sh(args, cwd):
    return subprocess.run(args, cwd=cwd, capture_output=True, text=True)

def run_tests(tag):
    r = sh(["node", "--test", *TESTS], wt)
    open(os.path.join(out, f"{tag}.tap"), "w").write(r.stdout + r.stderr)
    cnt = {k: int(m.group(1)) if (m := re.search(rf"^# {k} (\d+)$", r.stdout, re.M)) else None for k in ("tests", "pass", "fail", "cancelled", "skipped", "todo")}
    failed = re.findall(r"^not ok \d+ - (.*)$", r.stdout, re.M)
    return {"exit": r.returncode, **cnt, "failed": failed}

assert sh(["git", "status", "--porcelain"], wt).stdout == "", "变异工作树不干净"
assert sh(["git", "rev-parse", "HEAD"], wt).stdout == sh(["git", "rev-parse", "HEAD"], head).stdout
res = {"head": sh(["git", "rev-parse", "HEAD"], wt).stdout.strip(), "tests": TESTS, "clean": run_tests("clean"), "mutants": []}
for mid, f, old, new, why in MUTANTS:
    p = os.path.join(wt, f); src = open(p).read()
    n = src.count(old)
    rec = {"id": mid, "file": f, "why": why, "matches": n}
    if n != 1:
        rec["verdict"] = "INVALID(注入点匹配数≠1)"
    else:
        open(p, "w").write(src.replace(old, new))
        try:
            rec.update(run_tests(mid))
            rec["verdict"] = "KILLED" if rec["exit"] != 0 and rec["failed"] and rec["cancelled"] == 0 else "SURVIVED" if rec["exit"] == 0 else "INCONCLUSIVE"
        finally:
            sh(["git", "checkout", "--", f], wt)
    res["mutants"].append(rec)
    print(mid, rec["verdict"], rec.get("tests"), rec.get("fail"), rec.get("failed", [])[:3], flush=True)
assert sh(["git", "status", "--porcelain"], wt).stdout == ""
res["clean_after"] = run_tests("clean-after")
json.dump(res, open(os.path.join(out, "results.json"), "w"), ensure_ascii=False, indent=1)
print("clean", res["clean"]["exit"], res["clean"]["tests"], res["clean"]["pass"], "| after", res["clean_after"]["exit"], res["clean_after"]["pass"])
