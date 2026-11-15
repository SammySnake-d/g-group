#!/usr/bin/env python3
"""PR #95 第 2 轮审查人自构单点故障(作者清单之外),在隔离工作树里跑 memory-write-neighbors.test.ts。
用法: python3 mutants-r2.py <变异工作树(HEAD 干净检出)> <输出目录>"""
import json, os, re, subprocess, sys
wt, out = sys.argv[1:3]; os.makedirs(out, exist_ok=True)
TESTS = ["packages/server/src/memory-write-neighbors.test.ts"]; H = "packages/server/src/host.ts"
CALL = "q.text, visible.length)"
MAP = ".map((hit) => { const e = byId.get(hit.ref)!; return { id: e.id, title: e.title, body: e.body }; });"
MUTANTS = [
  ("N1-default-limit", CALL, "q.text)", "不传上限,落到检索函数的默认值 5"),
  ("N2-cap-5", CALL, "q.text, Math.min(5, visible.length))", "静默截断到 5 条"),
  ("N3-cap-4", CALL, "q.text, Math.min(4, visible.length))", "静默截断到 4 条(对照:应被五条夹具发现)"),
  ("N4-limit-minus-one", CALL, "q.text, visible.length - 1)", "少取一条"),
  ("N5-swap-title-body", MAP, MAP.replace("title: e.title, body: e.body", "title: e.body, body: e.title"), "返回项标题与正文对调"),
  ("N6-rank-by-id-only", MAP, ".sort((a, b) => a.ref < b.ref ? -1 : 1)" + MAP, "命中后改按 id 排,不看相关度"),
  ("N7-coarse-rooms-empty", "this.memoryNeighbors(contact.id,{rooms:work.rooms,text:material})", "this.memoryNeighbors(contact.id,{rooms:[],text:material})", "粗筛不带会话:本会话锚点的记忆进不了邻域"),
  ("N8-fine-rooms-empty", "this.memoryNeighbors(contactId, { rooms, text:", "this.memoryNeighbors(contactId, { rooms: [], text:", "精筛不带会话"),
  ("N9-fine-first-mark-only", 'text: batch.map((b) => b.mark.evidence ?? "").join("\\n") }', 'text: batch.slice(0, 1).map((b) => b.mark.evidence ?? "").join("\\n") }', "精筛只用本批第一条原文检索"),
  ("N10-room-anchor-any", 'a.startsWith("room:") && q.rooms.includes(a.slice(5))', 'a.startsWith("room:")', "任何会话锚点都算可见(作者 M06 的同类,对照)"),
]
def sh(a, cwd): return subprocess.run(a, cwd=cwd, capture_output=True, text=True)
def run(tag):
    r = sh(["node", "--test", "--test-concurrency=1", *TESTS], wt); open(os.path.join(out, f"{tag}.tap"), "w").write(r.stdout + r.stderr)
    c = {k: int(m.group(1)) if (m := re.search(rf"^# {k} (\d+)$", r.stdout, re.M)) else None for k in ("tests", "pass", "fail", "cancelled", "skipped", "todo")}
    return {"exit": r.returncode, **c, "failed": re.findall(r"^not ok \d+ - (.*)$", r.stdout, re.M)}
assert sh(["git", "status", "--porcelain"], wt).stdout == ""
res = {"head": sh(["git", "rev-parse", "HEAD"], wt).stdout.strip(), "tests": TESTS, "clean": run("clean"), "mutants": []}
p = os.path.join(wt, H)
for mid, old, new, why in MUTANTS:
    src = open(p).read(); n = src.count(old); rec = {"id": mid, "why": why, "matches": n, "before": old, "after": new}
    if n != 1: rec["verdict"] = "INVALID"
    else:
        open(p, "w").write(src.replace(old, new))
        try:
            rec.update(run(mid)); rec["verdict"] = "KILLED" if rec["exit"] != 0 and rec["failed"] and rec["cancelled"] == 0 else "SURVIVED" if rec["exit"] == 0 else "INCONCLUSIVE"
        finally: sh(["git", "checkout", "--", H], wt)
    res["mutants"].append(rec); print(mid, rec["verdict"], rec.get("matches"), rec.get("fail"), [x[:28] for x in rec.get("failed", [])][:4], flush=True)
res["clean_after"] = run("clean-after")
json.dump(res, open(os.path.join(out, "results.json"), "w"), ensure_ascii=False, indent=1)
print("clean", res["clean"]["exit"], res["clean"]["pass"], "| after", res["clean_after"]["exit"], res["clean_after"]["pass"])
