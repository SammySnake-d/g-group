#!/usr/bin/env python3
"""只读核对:已交付、没有审查人的任务是不是停在 T8a 待确认(交付快照),或经本人验收到了 T8(最终库)。

需求文档 §8.1 已定 1、验收文档 AC-28 / AC-56:联系人交活后进 T8a_Delivered(待确认),沉默不算通过;
提出者本人普通回复「通过」才进 T8_Accepted。没有跨厂商审查人时,本人通过如实记为 reviewGate=waived-by-user。

用法(用 python3 -I 跑;库一律以 mode=ro&immutable=1 只读打开,前后核对 sha256 不变):
  python3 -I check-t8a.py [--out result.json] --snapshot DB[=TASK_ID] ... --final DB ...
  --snapshot DB=TASK  交付那一刻的快照:TASK 必须是 T8a_Delivered、reviewGate=none、badge=none、deliveredSeq>0;
                      库里其余「已交付、没有审查人」的任务只许是 T8a 或已由本人验收的 T8。
  --snapshot DB       快照里每一件「已交付、没有审查人」的任务都必须是 T8a(旧证据库就按这个判)。
  --final DB          最终库:每一件「已交付、没有审查人」的任务都必须是 T8_Accepted、badge=accepted、reviewGate=waived-by-user。
退出码:0 全部通过;1 有断言失败(红);2 用法错误或库读不了。结果 JSON 打到标准输出,给了 --out 再写一份。
"""
import argparse
import hashlib
import json
import pathlib
import sqlite3
import sys

T8A = "T8a_Delivered"
T8 = "T8_Accepted"


def sha256(p: pathlib.Path) -> str:
    h = hashlib.sha256()
    with p.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def split_spec(spec: str):
    """DB=TASK_ID:只有 = 后面像任务号(t-...)才拆,路径里自带 = 也不误拆。"""
    head, sep, tail = spec.rpartition("=")
    if sep and tail.startswith("t-") and "/" not in tail:
        return head, tail
    return spec, None


def check(name, ok, detail):
    return {"name": name, "pass": bool(ok), "detail": detail}


def accepted_ok(t):
    return t["state"] == T8 and t.get("badge") == "accepted" and t.get("reviewGate") == "waived-by-user"


def judge(kind, pinned, row):
    """一件已交付、没有审查人的任务 → 具名断言列表。"""
    t = row["task"]
    st, gate, badge, seq = t["state"], t.get("reviewGate"), t.get("badge"), row["deliveredSeq"]
    facts = f"state={st} reviewGate={gate} badge={badge} deliveredSeq={seq}"
    out = []
    if kind == "final":
        out.append(check("final.state_T8_Accepted", st == T8, facts))
        out.append(check("final.badge_accepted", badge == "accepted", facts))
        out.append(check("final.reviewGate_waived_by_user", gate == "waived-by-user", facts))
        return out
    if pinned is None or row["id"] == pinned:
        out.append(check("snapshot.state_T8a_Delivered", st == T8A, facts + ("" if st == T8A else f";交付后停在 {st},不是 T8a 待确认")))
        out.append(check("snapshot.reviewGate_none", gate == "none", facts))
        out.append(check("snapshot.badge_none", badge == "none", facts))
        return out
    # 快照里别的已交付任务(例如私聊那件在群聊交付时已由本人验收):只许 T8a 或本人验收的 T8
    out.append(check("snapshot.other_task_T8a_or_accepted", st == T8A or accepted_ok(t), facts))
    return out


def read_db(path: pathlib.Path):
    for suffix in ("-wal",):
        side = pathlib.Path(str(path) + suffix)
        if side.exists() and side.stat().st_size > 0:
            raise RuntimeError(f"{side} 非空:immutable 只读会忽略 WAL 里的新数据,先用 sqlite backup 拷一份快照再核对")
    cn = sqlite3.connect(path.as_uri() + "?mode=ro&immutable=1", uri=True)
    try:
        rows = []
        for key, ver, raw in cn.execute("SELECT key, ver, value FROM docs WHERE substr(key, 1, 5) = 'task:' ORDER BY key"):
            doc = json.loads(raw)
            t = doc["task"]
            reviews = cn.execute("SELECT count(*) FROM gg_reviews WHERE task_id = ?", (t["id"],)).fetchone()[0]
            rows.append({
                "id": t["id"], "ver": ver, "task": t, "title": doc.get("title"), "roomId": doc.get("roomId"),
                "sourceSeq": doc.get("sourceSeq"), "deliveredSeq": doc.get("deliveredSeq"), "reviews": reviews,
            })
        return rows
    finally:
        cn.close()


def run_one(kind, spec):
    path_s, pinned = split_spec(spec)
    path = pathlib.Path(path_s).resolve(strict=True)
    before = sha256(path)
    rows = read_db(path)
    after = sha256(path)
    entry = {"kind": kind, "db": str(path), "pinned_task": pinned, "sha256": before, "unchanged_after_read": before == after, "tasks": [], "checks": []}
    entry["checks"].append(check("db.read_only_unchanged", before == after, f"sha256 前 {before} 后 {after}"))
    # 「已交付、没有审查人」:有交付消息(deliveredSeq>0),审查表里没有这件任务的审查
    scoped = [r for r in rows if isinstance(r["deliveredSeq"], int) and r["deliveredSeq"] > 0 and r["reviews"] == 0]
    entry["checks"].append(check("db.has_delivered_no_review_task", len(scoped) > 0, f"已交付且无审查人的任务 {len(scoped)} 件 / 全部 {len(rows)} 件"))
    if pinned is not None:
        entry["checks"].append(check("snapshot.pinned_task_present", any(r["id"] == pinned for r in scoped), f"指定任务 {pinned}"))
    for r in scoped:
        t = r["task"]
        cs = judge(kind, pinned, r)
        entry["tasks"].append({
            "task_id": r["id"], "doc_version": r["ver"], "room_id": r["roomId"], "title": r["title"],
            "requester": t.get("requester"), "owner": t.get("owner"), "state": t["state"], "reviewGate": t.get("reviewGate"),
            "badge": t.get("badge"), "deliveredSeq": r["deliveredSeq"], "sourceSeq": r["sourceSeq"], "reviews": r["reviews"],
            "approval": t.get("approval"), "delivery": t.get("delivery"), "checks": cs,
        })
    entry["pass"] = all(c["pass"] for c in entry["checks"]) and all(c["pass"] for x in entry["tasks"] for c in x["checks"])
    return entry


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--snapshot", action="append", default=[], metavar="DB[=TASK_ID]")
    ap.add_argument("--final", action="append", default=[], metavar="DB")
    ap.add_argument("--out", type=pathlib.Path)
    a = ap.parse_args()
    if not a.snapshot and not a.final:
        ap.error("至少给一个 --snapshot 或 --final")
    if a.out is not None and a.out.exists():
        ap.error(f"{a.out} 已存在,不覆盖")
    try:
        dbs = [run_one("snapshot", s) for s in a.snapshot] + [run_one("final", s) for s in a.final]
    except (OSError, sqlite3.Error, RuntimeError, KeyError, ValueError) as e:
        print(json.dumps({"error": f"{type(e).__name__}: {e}"}, ensure_ascii=False), file=sys.stderr)
        return 2
    failed = [f"{d['db']}::{x['task_id']}::{c['name']}: {c['detail']}" for d in dbs for x in d["tasks"] for c in x["checks"] if not c["pass"]]
    failed += [f"{d['db']}::{c['name']}: {c['detail']}" for d in dbs for c in d["checks"] if not c["pass"]]
    result = {"pass": all(d["pass"] for d in dbs), "failed": failed, "dbs": dbs}
    text = json.dumps(result, ensure_ascii=False, indent=2) + "\n"
    sys.stdout.write(text)
    if a.out is not None:
        a.out.write_text(text, encoding="utf-8")
    return 0 if result["pass"] else 1


if __name__ == "__main__":
    sys.exit(main())
