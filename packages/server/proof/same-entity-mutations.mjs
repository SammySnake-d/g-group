// 行为变异校准(R-05 阳性埋雷,AC-02):对「群入口与侧边栏读同一实体」逐个注入单一故障,在隔离副本里跑 same-entity.test.ts,
// 每个变异都必须让至少一条具名测试失败;注入点在源码里必须恰好出现 1 次。原样副本必须全绿(阴性对照)。
// 用法: node packages/server/proof/same-entity-mutations.mjs
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PKG = path.resolve(import.meta.dirname, "..");
const ROOT = path.resolve(PKG, "../..");
const TESTS = ["src/same-entity.test.ts"];
const CACHE = "const __c = ((globalThis as { __gg?: Map<string, unknown> }).__gg ??= new Map());";

const M = [
  ["E01 侧边栏(按联系人过滤)读缓存副本", "host.ts", "    return listDocs<TaskDoc>(this.db, \"task:\")\n      .filter(", `    ${CACHE}\n    if (q.contactId && __c.has(JSON.stringify(q))) return __c.get(JSON.stringify(q)) as TaskView[];\n    const __r = listDocs<TaskDoc>(this.db, "task:")\n      .filter(`],
  ["E02 任务详情读缓存副本", "host.ts", "    const d = this.taskDoc(id);\n    return this.taskView(d.value, d.ver);", `    ${CACHE}\n    if (__c.has(id)) return __c.get(id) as TaskView;\n    const d = this.taskDoc(id);\n    const __v = this.taskView(d.value, d.ver);\n    __c.set(id, __v);\n    return __v;`],
  ["E03 stateVer 恒为 1", "host.ts", "      stateVer: ver ?? this.taskDoc(t.id).ver,", "      stateVer: 1,"],
  ["E04 列表不带权威版本", "host.ts", "      .map((d) => this.taskView(d.value, d.ver));", "      .map((d) => this.taskView(d.value, 1));"],
  ["E05 事件里的版本落后一版", "host.ts", "    this.bus.emit({ type: \"task.updated\", task: this.taskViewById(id) });", "    this.bus.emit({ type: \"task.updated\", task: this.taskView(this.taskDoc(id).value, Math.max(1, this.taskDoc(id).ver - 1)) });"],
  ["E06 侧边栏不按联系人过滤", "host.ts", "(!q.contactId || d.task.owner === q.contactId)", "true"],
];

function run(dir) {
  const r = spawnSync(process.execPath, ["--no-warnings", "--test", "--test-reporter=tap", "--test-concurrency=1", ...TESTS], { cwd: dir, encoding: "utf8", timeout: 180_000 });
  const failed = [...(r.stdout ?? "").matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1]);
  const passed = [...(r.stdout ?? "").matchAll(/^ok \d+ - (.+)$/gm)].map((m) => m[1]);
  return { code: r.status, failed, passed };
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "server-same-mut-"));
const copy = (name) => {
  const d = path.join(tmp, name);
  fs.cpSync(PKG, d, { recursive: true, filter: (s) => !s.includes(`${path.sep}proof`) && !s.includes(`${path.sep}node_modules`) });
  fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(d, "node_modules"));
  return d;
};
let ok = true;
try {
  const base = run(copy("base"));
  if (base.failed.length || !base.passed.length) {
    console.log(`✗ 原样副本:${base.passed.length} 绿 / ${base.failed.length} 红(应全绿)`);
    ok = false;
  } else console.log(`✓ 原样副本:${base.passed.length} 绿 / 0 红`);
  for (const [name, file, from, to] of M) {
    const d = copy(name.split(" ")[0]);
    const f = path.join(d, "src", file);
    const src = fs.readFileSync(f, "utf8");
    const hits = src.split(from).length - 1;
    if (hits !== 1) {
      console.log(`✗ ${name}:注入点出现 ${hits} 次(应恰好 1 次)`);
      ok = false;
      continue;
    }
    let next = src.replace(from, to);
    if (name.startsWith("E01")) next = next.replace("      .map((d) => this.taskView(d.value, d.ver));\n", "      .map((d) => this.taskView(d.value, d.ver));\n    if (q.contactId) __c.set(JSON.stringify(q), __r);\n    return __r;\n");
    fs.writeFileSync(f, next);
    const r = run(d);
    if (r.failed.length) console.log(`✓ ${name}:${r.passed.length} 绿 / ${r.failed.length} 红,被「${r.failed[0]}」发现`);
    else {
      console.log(`✗ ${name}:存活(${r.passed.length} 绿 / 0 红)`);
      ok = false;
    }
    fs.rmSync(d, { recursive: true, force: true });
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(`${M.length} 个变异`);
console.log(ok ? "变异校准通过" : "变异校准失败");
process.exit(ok ? 0 : 1);
