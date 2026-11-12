// T-177 G3/G5 write-neighborhood mutants. Reuses the G3 named-test runner and serial restore protocol.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
const T = "packages/server/src/memory-write-neighbors.test.ts";
const cases = [
  [
    "G35-M01",
    "packages/server/src/host.ts",
    "return searchMemoryNeighborhood(visible.map((e) => ({ ref: e.id, role: \"user\" as const, text: `${e.title}\\n${e.body}` })), q.text, visible.length)\n      .map((hit) => { const e = byId.get(hit.ref)!; return { id: e.id, title: e.title, body: e.body }; });",
    "return visible.map((e) => ({ id: e.id, title: e.title, body: e.body }));",
    "packages/server/src/memory-write-neighbors.test.ts",
    "G35-02 ",
    "return every eligible memory instead of retrieval"
  ],
  [
    "G35-M02",
    "packages/server/src/host.ts",
    "q.text, visible.length)",
    "\"\", visible.length)",
    "packages/server/src/memory-write-neighbors.test.ts",
    "G35-01 ",
    "ignore the write-neighborhood query"
  ],
  [
    "G35-M03",
    "packages/server/src/host.ts",
    ".sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);",
    ".sort((a, b) => a.id < b.id ? 1 : a.id > b.id ? -1 : 0);",
    "packages/server/src/memory-write-neighbors.test.ts",
    "G35-01 ",
    "reverse stable tied order"
  ],
  [
    "G35-M04",
    "packages/server/src/host.ts",
    "(e.status === \"active\" || e.status === \"degraded\") && !e.anchors.includes(PERSONA_ANCHOR)",
    "true && !e.anchors.includes(PERSONA_ANCHOR)",
    "packages/server/src/memory-write-neighbors.test.ts",
    "G35-03 ",
    "include revoked and superseded entries"
  ],
  [
    "G35-M05",
    "packages/server/src/host.ts",
    "!e.anchors.includes(PERSONA_ANCHOR)",
    "true",
    "packages/server/src/memory-write-neighbors.test.ts",
    "G35-03 ",
    "include persona suggestions"
  ],
  [
    "G35-M06",
    "packages/server/src/host.ts",
    "e.anchors.some((a) => a === \"global\" || a.startsWith(\"room:\") && q.rooms.includes(a.slice(5)))",
    "e.anchors.some(() => true)",
    "packages/server/src/memory-write-neighbors.test.ts",
    "G35-03 ",
    "include memories from unrelated rooms"
  ],
  [
    "G35-M07",
    "packages/server/src/host.ts",
    "a === \"global\" || a.startsWith(\"room:\")",
    "a.startsWith(\"room:\")",
    "packages/server/src/memory-write-neighbors.test.ts",
    "G35-01 ",
    "drop global matching entries"
  ],
  [
    "G35-M08",
    "packages/server/src/host.ts",
    "(e.status === \"active\" || e.status === \"degraded\") && !e.anchors.includes(PERSONA_ANCHOR)",
    "(e.status === \"active\") && !e.anchors.includes(PERSONA_ANCHOR)",
    "packages/server/src/memory-write-neighbors.test.ts",
    "G35-01 ",
    "drop degraded matching entries"
  ],
  [
    "G35-M09",
    "packages/server/src/host.ts",
    "const visible = this.memory.list(contactId)\n",
    "const visible = this.listContacts().flatMap((contact) => this.memory.list(contact.id))\n",
    "packages/server/src/memory-write-neighbors.test.ts",
    "G35-03 ",
    "mix another contact memory into this neighborhood"
  ],
  [
    "G35-M10",
    "packages/server/src/host.ts",
    "this.memoryNeighbors(contact.id,{rooms:work.rooms,text:material})",
    "this.memoryNeighbors(contact.id,{rooms:work.rooms,text:\"\"})",
    "packages/server/src/memory-write-neighbors.test.ts",
    "G35-01 ",
    "coarse path passes an empty query"
  ],
  [
    "G35-M11",
    "packages/server/src/host.ts",
    "this.memoryNeighbors(contactId, { rooms, text: batch.map((b) => b.mark.evidence ?? \"\").join(\"\\n\") })",
    "this.memoryNeighbors(contactId, { rooms, text: \"\" })",
    "packages/server/src/memory-write-neighbors.test.ts",
    "G35-01 ",
    "fine path passes an empty query"
  ],
  [
    "G35-M12",
    "packages/server/src/host.ts",
    ".map((hit) => { const e = byId.get(hit.ref)!; return { id: e.id, title: e.title, body: e.body }; });",
    ".map((hit) => { const e = byId.get(hit.ref)!; return { id: e.id, title: e.title, body: \"\" }; });",
    "packages/server/src/memory-write-neighbors.test.ts",
    "G35-01 ",
    "lose matched memory bodies"
  ]
];

const out = process.argv[2] ?? "receipts/evidence/t177-g35/mutations";
mkdirSync(out, { recursive: true });
const LOAD_FAIL = /SyntaxError:|ERR_MODULE_NOT_FOUND|ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX|Cannot find module|does not provide an export/;
function run(files, name, pattern) {
  const args = ["--test", "--test-concurrency=1", "--test-timeout=60000", "--test-force-exit", "--test-reporter=tap", ...(pattern ? [`--test-name-pattern=^${pattern}`] : []), ...files];
  const r = spawnSync(process.execPath, args, { cwd: process.cwd(), encoding: "utf8", timeout: 300_000, maxBuffer: 64 * 1024 * 1024 });
  const log = (r.stdout ?? "") + (r.stderr ?? "");
  writeFileSync(path.join(out, `${name}.tap`), log);
  const failed = [...log.matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1]);
  const passed = [...log.matchAll(/^ok \d+ - (.+)$/gm)].map((m) => m[1]);
  return { status: r.status, signal: r.signal, log, failed, passed };
}
const control = run([T], "control");
console.log(`原样对照:通过 ${control.passed.length},失败 ${control.failed.length},退出 ${control.status}`);
if (control.status !== 0 || control.failed.length || control.passed.length !== 3) { console.log("原样对照不全绿,不判变异"); process.exit(1); }
const results = [];
for (const [id, file, before, after, testFile, prefix, why] of cases) {
  const source = readFileSync(file, "utf8");
  const n = source.split(before).length - 1;
  if (n !== 1) { results.push({ id, file, why, status: "invalid", reason: `注入点出现 ${n} 次` }); console.log(`${id} 注入点出现 ${n} 次,作废`); continue; }
  try {
    writeFileSync(file, source.replace(before, after));
    const r = run([testFile], id, prefix);
    const named = r.failed.filter((t) => t.startsWith(prefix));
    const loadFail = LOAD_FAIL.test(r.log);
    const killed = r.status !== 0 && named.length > 0 && !loadFail && r.signal === null;
    results.push({ id, file, why, designated: `${testFile} › ${prefix.trim()}…`, status: killed ? "killed" : "survived", exit: r.status, signal: r.signal, loadFail, failed: r.failed });
    console.log(`${id} ${killed ? "杀死" : "存活"}:${why}${killed ? `(被「${named[0]}」发现)` : ""}`);
  } finally { writeFileSync(file, source); }
}
const after = run([T], "after-control");
const summary = { node: process.version, mutations: results.length, killed: results.filter((r) => r.status === "killed").length, survived: results.filter((r) => r.status !== "killed").length, control: { passed: control.passed.length, failed: control.failed.length }, afterControl: { passed: after.passed.length, failed: after.failed.length, exit: after.status } };
writeFileSync(path.join(out, "results.json"), `${JSON.stringify({ summary, results }, null, 2)}\n`);
console.log(JSON.stringify(summary));
process.exit(summary.survived === 0 && after.status === 0 && after.passed.length === 3 ? 0 : 1);
