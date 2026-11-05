// 行为变异校准(R-05 阳性埋雷):对 adapter-sqlite 的实现逐个注入单一故障,在隔离副本里跑本包测试(真实 sqlite 文件),
// 每个变异都必须让至少一条具名测试失败;注入点在源码里必须恰好出现 1 次,否则脚本判失败。原样副本必须全绿(阴性对照)。
// 用法: node packages/adapter-sqlite/proof/mutations.mjs
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PKG = path.resolve(import.meta.dirname, "..");
const ROOT = path.resolve(PKG, "../..");

const M = [
  ["S01 删 UPDATE 触发器", "store.ts", "CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;", ""],
  ["S02 删 DELETE 触发器", "store.ts", "CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;", ""],
  ["S03 覆盖 INSERT 触发器永不生效", "store.ts", "WHEN EXISTS (SELECT 1 FROM events WHERE session = NEW.session AND seq = NEW.seq)", "WHEN 0"],
  ["S04 CAS 不比版本", "store.ts", 'if (cur !== expectedVer) return { ok: false, reason: "version-conflict", currentVer: cur };', ""],
  ["S05 CAS 不在事务里", "store.ts", "return tx(s.db, () => cas(s, key, expectedVer, value));", "return cas(s, key, expectedVer, value);"],
  ["S06 事务不先拿写锁(DEFERRED)", "store.ts", 'db.exec("BEGIN IMMEDIATE");', 'db.exec("BEGIN");'],
  ["S07 action_id 不唯一", "store.ts", "CREATE UNIQUE INDEX IF NOT EXISTS actions_action_id", "CREATE INDEX IF NOT EXISTS actions_action_id"],
  ["S08 重放覆盖原动作", "store.ts", "INSERT OR IGNORE INTO actions", "INSERT OR REPLACE INTO actions"],
  ["S09 load 不 verify", "store.ts", "return { log, check: verify(log) };", "return { log, check: { ok: true } };"],
  ["S10 重启后丢表", "store.ts", "db.exec(SCHEMA);", 'db.exec("DROP TABLE IF EXISTS events; DROP TABLE IF EXISTS docs; DROP TABLE IF EXISTS actions;"); db.exec(SCHEMA);'],
  ["S11 追加不接旧链(每次从空日志算)", "store.ts", "append({ events: readEvents(s.db, sessionId) }, sender, body, at)", "append({ events: [] }, sender, body, at)"],
  ["S12 读事件不按会话过滤", "store.ts", "FROM events WHERE session = ? ORDER BY seq\").all(sessionId)", "FROM events WHERE ? IS NOT NULL ORDER BY seq\").all(sessionId)"],
  ["S13 CAS 冲突时仍写入", "store.ts", "  s.onCasRead?.(key, cur);\n", "  s.onCasRead?.(key, cur);\n  if (cur !== expectedVer) { s.db.prepare(\"INSERT INTO docs (key, ver, value) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value\").run(key, cur, JSON.stringify(value)); }\n"],
];

function run(dir) {
  const files = fs.readdirSync(path.join(dir, "src")).filter((f) => f.endsWith(".test.ts")).map((f) => path.join("src", f));
  const r = spawnSync(process.execPath, ["--no-warnings", "--test", "--test-reporter=tap", "--test-concurrency=1", ...files], { cwd: dir, encoding: "utf8", timeout: 120_000 });
  const failed = [...(r.stdout ?? "").matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1]);
  const passed = [...(r.stdout ?? "").matchAll(/^ok \d+ - (.+)$/gm)].map((m) => m[1]);
  return { code: r.status, failed, passed };
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "adapter-sqlite-mut-"));
const copy = (name) => {
  const d = path.join(tmp, name);
  fs.cpSync(PKG, d, { recursive: true, filter: (s) => !s.includes(`${path.sep}proof`) });
  fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(d, "node_modules"));
  return d;
};
let ok = true;
const clean = run(copy("clean"));
console.log(`${clean.code === 0 && clean.failed.length === 0 ? "✓" : "✗"} 原样副本:${clean.passed.length} 绿 / ${clean.failed.length} 红`);
if (clean.code !== 0 || clean.failed.length > 0 || clean.passed.length === 0) ok = false;
M.forEach(([name, file, from, to], i) => {
  const d = copy(`m${i}`);
  const f = path.join(d, "src", file);
  const src = fs.readFileSync(f, "utf8");
  const hits = src.split(from).length - 1;
  if (hits !== 1) { ok = false; console.log(`✗ ${name}:注入点出现 ${hits} 次(必须恰好 1 次,实现已变就更新本脚本)`); return; }
  fs.writeFileSync(f, src.replace(from, to));
  const r = run(d);
  const killed = r.failed.length > 0;
  if (!killed) ok = false;
  console.log(`${killed ? "✓" : "✗"} ${name}:${r.passed.length} 绿 / ${r.failed.length} 红${killed ? `,被「${r.failed[0]}」发现` : ",存活"}`);
});
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`${M.length} 个变异`);
console.log(ok ? "变异校准通过" : "变异校准失败");
process.exit(ok ? 0 : 1);
