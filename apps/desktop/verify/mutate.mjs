#!/usr/bin/env node
// 埋雷校验(开发手册原则 40「没见过它失败的检查不算数」):把实现故意改坏,对应的 e2e 必须变红。
// 用法:node verify/mutate.mjs [雷的 id 前缀…]   结果写到 verify/mutation-report.json
// 每颗雷:改一个源文件里的一段文字 → 重建渲染层 → 跑指定测试 → 必须失败 → 还原。
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const here = path.dirname(new URL(import.meta.url).pathname);
const root = path.resolve(here, "..");
const mines = JSON.parse(fs.readFileSync(path.join(here, "mines.json"), "utf8"));
const only = process.argv.slice(2);
const port = process.env.GG_PW_PORT ?? "5198";
const results = [];

function build() {
  execFileSync("npx", ["vite", "build"], { cwd: root, stdio: "ignore" });
}

for (const m of mines.filter((x) => only.length === 0 || only.some((o) => x.id.startsWith(o)))) {
  const file = path.join(root, m.file);
  const orig = fs.readFileSync(file, "utf8");
  const hits = orig.split(m.find).length - 1;
  if (hits !== 1) {
    results.push({ id: m.id, ok: false, why: `要替换的文字出现 ${hits} 次(应为 1 次),雷没埋上` });
    continue;
  }
  try {
    fs.writeFileSync(file, orig.replace(m.find, m.replace));
    build();
    const r = spawnSync("npx", ["playwright", "test", "--project=renderer", m.spec, ...(m.grep ? ["--grep", m.grep] : [])], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, GG_PW_PORT: port },
    });
    const failed = r.status !== 0 && /\d+ failed/.test(r.stdout);
    results.push({ id: m.id, desc: m.desc, spec: m.spec, ok: failed, why: failed ? "测试变红,抓到了" : "测试仍然通过,这颗雷没被抓到" });
    console.log(`${failed ? "✓" : "✗"} ${m.id} ${m.desc}`);
  } finally {
    fs.writeFileSync(file, orig);
  }
}
build();
fs.writeFileSync(path.join(here, "mutation-report.json"), `${JSON.stringify({ at: new Date().toISOString(), results }, null, 2)}\n`);
const bad = results.filter((r) => !r.ok);
console.log(`\n埋雷 ${results.length} 颗,抓到 ${results.length - bad.length},漏掉 ${bad.length}`);
process.exit(bad.length ? 1 : 0);
