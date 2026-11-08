#!/usr/bin/env node
// 逐条对照表:跑全部 e2e(renderer + electron),按 feature-map.json 把每个功能对到需求条目、测试结果、截图。
// 用法:node verify/report.mjs [输出目录]   默认输出到交付目录的 对照表.md
// 结论只看真实运行:某功能的测试有一条没过或没跑到,这一行就记「失败」或「未测」,不手填。
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const here = path.dirname(new URL(import.meta.url).pathname);
const root = path.resolve(here, "..");
const outDir = process.argv[2] ?? "/Users/snakesammy/.mirasim/assistants/deliverables/g-group-desktop-ui";
const map = JSON.parse(fs.readFileSync(path.join(here, "feature-map.json"), "utf8"));

const r = spawnSync("npx", ["playwright", "test", "--reporter=json"], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env: { ...process.env, ELECTRON_RUN_AS_NODE: "" } });
const json = JSON.parse(r.stdout);
const tests = [];
const walk = (suite, file) => {
  for (const s of suite.suites ?? []) walk(s, s.file ?? file);
  for (const spec of suite.specs ?? []) for (const t of spec.tests) {
    const res = t.results.at(-1);
    tests.push({ file: spec.file ?? file, title: [suite.title, spec.title].filter((x) => x && !x.endsWith(".ts")).join(" › "), project: t.projectName, status: res?.status ?? "skipped", ms: res?.duration ?? 0 });
  }
};
for (const s of json.suites) walk(s, s.file);

const rows = [];
let pass = 0;
for (const f of map.features) {
  const mine = tests.filter((t) => f.tests.some((q) => `${path.basename(t.file)} › ${t.title}`.includes(q)));
  const ok = mine.length > 0 && mine.every((t) => t.status === "passed");
  const status = mine.length === 0 ? "未测" : ok ? "通过" : "失败";
  if (ok) pass++;
  const shots = (f.shots ?? []).filter((s) => fs.existsSync(path.join(outDir, "shots", s)));
  rows.push(`| ${f.id} | ${f.title} | ${f.req.join(" ")} | ${status} | ${mine.filter((t) => t.status === "passed").length}/${mine.length} | ${shots.map((s) => `[${s}](shots/${s})`).join(" ") || "—"} | ${f.note ?? ""} |`);
}
const total = tests.length, passed = tests.filter((t) => t.status === "passed").length;
const md = `# g-group 桌面前端 · 逐条对照表

生成时间:${new Date().toISOString()}(由 \`apps/desktop/verify/report.mjs\` 跑真实 e2e 生成,不手填)
e2e 总计 ${total} 条,通过 ${passed} 条;功能 ${map.features.length} 项,通过 ${pass} 项。

| 编号 | 功能 | 对应需求/意见 | 结论 | 测试 | 截图 | 说明 |
|---|---|---|---|---|---|---|
${rows.join("\n")}
`;
fs.writeFileSync(path.join(outDir, "对照表.md"), md);
console.log(md.split("\n").slice(0, 4).join("\n"));
process.exit(pass === map.features.length && passed === total ? 0 : 1);
