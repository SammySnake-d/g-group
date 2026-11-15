// 行为变异校准(R-05 阳性埋雷):对 AC-25 搜索 / AC-08 索引删除的关键判据逐个注入单一故障,
// 在隔离副本里跑 search.test.ts 与 api-contract/search-contract.test.ts。每个变异必须让至少一条具名测试失败,
// 且两个文件都完整执行(文件级失败不算杀死);原样副本必须全绿(阴性对照)。注入点在源文件里必须恰好出现 1 次。
// 用法: node packages/server/proof/e-search-mutations.mjs   (逐个串行跑,本机负载高时也不加并发)
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const TESTS = ["packages/server/src/search.test.ts", "packages/api-contract/src/search-contract.test.ts"];
const S = "packages/server/src/search.ts";
const H = "packages/server/src/host.ts";

const M = [
  ["M01 搜索不按成员过滤(LEFT JOIN 放进非成员会话)", S, "JOIN gg_members m ON m.room_id = s.room_id AND m.kind = 'user' AND m.member_id = ?", "LEFT JOIN gg_members m ON m.room_id = s.room_id AND m.kind = 'user' AND m.member_id = ?"],
  ["M02 撤回不删索引行", S, 'run(db, "DELETE FROM gg_search WHERE room_id = ? AND seq = ?", roomId, seq);', ""],
  ["M03 编辑不更新索引(旧文字仍命中)", S, 'run(db, "UPDATE gg_search SET text = ? WHERE room_id = ? AND seq = ?", text, roomId, seq);', ""],
  ["M04 LIKE 不转义 % _", S, String.raw`return s.replace(/[\\%_]/g, (c) => ` + "`\\\\${c}`);", "return s;"],
  ["M05 重建时不跳过撤回的消息", S, "if (m.retracted) continue;", ""],
  ["M06 启动不核对索引版本号", S, "if (had && ver === String(SEARCH_INDEX_VERSION)) return false;", "if (had) return false;"],
  ["M07 指定 roomId 时不核对成员", S, 'throw new HostError("forbidden", "你不在这个会话里");', "void 0;"],
  ["M08 aroundSeq 不居中(总取末页)", H, "const from = Math.max(0, Math.min(at - Math.floor((limit - 1) / 2), sel.length - limit));", "const from = Math.max(0, sel.length - limit);"],
  ["M09 分页游标含边界(重复返回上一页末条)", S, "(s.at, s.room_id, s.seq) < (?, ?, ?)", "(s.at, s.room_id, s.seq) <= (?, ?, ?)"],
  ["M10 附件名不进索引", S, String.raw`attNames(db, r.attachments).join("\n"),`, '"",'],
];

function copyRepo() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gg-e-search-mut-"));
  for (const e of fs.readdirSync(ROOT)) {
    if (e === ".git" || e === "node_modules") continue;
    fs.cpSync(path.join(ROOT, e), path.join(tmp, e), { recursive: true });
  }
  fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(tmp, "node_modules"));
  return tmp;
}
function runTests(dir) {
  const r = spawnSync(process.execPath, ["--test", "--test-concurrency=1", ...TESTS], { cwd: dir, encoding: "utf8", timeout: 600_000 });
  const out = `${r.stdout}\n${r.stderr}`;
  const num = (k) => Number(new RegExp(`^ℹ ${k} (\\d+)`, "m").exec(out)?.[1] ?? "NaN");
  const all = [...out.matchAll(/^✖ (.+?) \(\d/gm)].map((m) => m[1]);
  const failed = all.filter((n) => !TESTS.some((t) => n.includes(t)));
  // 文件级失败:node:test 把加载失败报成以文件路径命名的失败项
  return { pass: num("pass"), fail: num("fail"), tests: num("tests"), failed: [...new Set(failed)], fileLevel: all.some((n) => TESTS.some((t) => n.includes(t))), code: r.status };
}

const lines = [];
const log = (s) => {
  lines.push(s);
  console.log(s);
};
log(`# 运行环境 ${os.hostname()} ${process.platform} node ${process.version} ${new Date().toISOString()}`);
const dir = copyRepo();
let bad = 0;
try {
  const base = runTests(dir);
  log(`${base.fail === 0 && base.code === 0 ? "✓" : "✗"} 原样副本:${base.pass} 绿 / ${base.fail} 红,共 ${base.tests} 条,退出码 ${base.code}`);
  if (base.fail !== 0 || base.code !== 0) bad++;
  for (const [name, file, from, to] of M) {
    const f = path.join(dir, file);
    const orig = fs.readFileSync(f, "utf8");
    const count = orig.split(from).length - 1;
    if (count !== 1) {
      log(`✗ ${name}:注入点在 ${file} 出现 ${count} 次(应恰好 1 次),脚本失效`);
      bad++;
      continue;
    }
    fs.writeFileSync(f, orig.replace(from, to));
    const r = runTests(dir);
    fs.writeFileSync(f, orig);
    const killed = r.fail > 0 && !r.fileLevel && r.tests === base.tests;
    if (!killed) bad++;
    log(`${killed ? "✓" : "✗"} ${name}:${r.pass} 绿 / ${r.fail} 红,${killed ? `被「${r.failed.join("」「")}」发现` : "存活或文件级失败"}`);
  }
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
log(`变异 ${M.length} 个,${bad === 0 ? "全部被具名测试杀死,原样全绿" : `${bad} 项不合格`}`);
process.exitCode = bad === 0 ? 0 : 1;
