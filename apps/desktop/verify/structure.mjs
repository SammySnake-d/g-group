#!/usr/bin/env node
// 结构检查(把 #932「做好解耦、代码拆分,不要硬编码常量、表情 Emoji」和 #929「优先用组件、原语」固化成机械规则):
//  1. 组件里不出现表情字面量(表情集合放 src/config/emoji.ts)
//  2. 组件里不写死色值(#rrggbb / rgb()),颜色走语义 token;插件品牌色这类数据放 data/config
//  3. 不用 transition-all(Vercel:只列出要过渡的属性)
//  4. 单文件不超过 400 行;历史大文件按 structure-baseline.json 的行数只许变少(棘轮),拆完从基线里删掉
//  5. 原生 <button> 的数量按文件只许变少(新代码用 Button / IconButton 原语)
//  1、2 在历史文件里同样按基线计数棘轮:只许变少,新文件一处都不许有。最终目标是基线清空。
// 用法:node verify/structure.mjs [--update-baseline]   失败时列出每一处
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const src = path.join(root, "src");
const baselinePath = path.join(root, "verify", "structure-baseline.json");
const MAX_LINES = 400;
const EXEMPT = [/^config\//, /^data\.ts$/, /^avatars\//, /^components\/ui\//, /^index\.css$/];
const files = [];
const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.(tsx?|css)$/.test(e.name)) files.push(path.relative(src, p).split(path.sep).join("/")); } };
walk(src);

const emoji = /\p{Extended_Pictographic}/u;
// 只认字符串/类名里的色值(引号、方括号、括号后紧跟 #),消息编号(#929)这类不算
const hex = /['"`(\[]#[0-9a-fA-F]{3,8}\b|rgba?\(\s*\d/;
const stripComments = (t) => t.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, (m) => m.replace(/[^\n]/g, " "));
const problems = [];
const sizes = {}, buttons = {}, literals = {};
for (const f of files) {
  const text = fs.readFileSync(path.join(src, f), "utf8");
  const lines = text.split("\n");
  const exempt = EXEMPT.some((re) => re.test(f));
  if (!exempt && /\.(tsx|ts)$/.test(f)) {
    const hits = [];
    stripComments(text).split("\n").forEach((l, i) => {
      const code = l.replace(/\/\/.*$/, "");
      if (emoji.test(code)) hits.push(`${f}:${i + 1} 组件里写了表情字面量,放到 src/config/emoji.ts`);
      if (hex.test(code)) hits.push(`${f}:${i + 1} 组件里写死了色值,改用语义 token(或把数据放进 data/config)`);
    });
    literals[f] = hits;
  }
  if (/transition-all\b/.test(stripComments(text).replace(/\/\/.*$/gm, ""))) problems.push(`${f} 用了 transition-all,只列出要过渡的属性`);
  if (!exempt && /\.(tsx|ts)$/.test(f)) {
    sizes[f] = lines.length;
    buttons[f] = (text.match(/<button\b/g) ?? []).length;
  }
}
const base = fs.existsSync(baselinePath) ? JSON.parse(fs.readFileSync(baselinePath, "utf8")) : { lines: {}, buttons: {} };
if (process.argv.includes("--update-baseline")) {
  const next = { note: "历史文件的棘轮基线:只许变小;拆分后删掉对应条目", lines: {}, buttons: {}, literals: {} };
  for (const [f, h] of Object.entries(literals)) if (h.length) next.literals[f] = h.length;
  for (const [f, n] of Object.entries(sizes)) if (n > MAX_LINES) next.lines[f] = n;
  for (const [f, n] of Object.entries(buttons)) if (n > 0) next.buttons[f] = n;
  fs.writeFileSync(baselinePath, `${JSON.stringify(next, null, 2)}\n`);
  console.log(`基线已写入 ${path.relative(root, baselinePath)}`);
}
const b2 = fs.existsSync(baselinePath) ? JSON.parse(fs.readFileSync(baselinePath, "utf8")) : base;
for (const [f, n] of Object.entries(sizes)) {
  const allowed = b2.lines?.[f] ?? MAX_LINES;
  if (n > allowed) problems.push(`${f} 有 ${n} 行,超过 ${allowed}(新文件上限 ${MAX_LINES};历史文件只许变少)`);
}
for (const [f, n] of Object.entries(buttons)) {
  const allowed = b2.buttons?.[f] ?? 0;
  if (n > allowed) problems.push(`${f} 有 ${n} 个原生 <button>,基线 ${allowed};新代码用 Button / IconButton 原语`);
}
for (const [f, h] of Object.entries(literals)) {
  const allowed = b2.literals?.[f] ?? 0;
  if (h.length > allowed) problems.push(...h, `${f} 表情/色值字面量 ${h.length} 处,基线 ${allowed}`);
}
const big = Object.entries(sizes).filter(([, n]) => n > MAX_LINES).sort((a, b) => b[1] - a[1]);
const rawButtons = Object.values(buttons).reduce((a, b) => a + b, 0);
console.log(`文件 ${Object.keys(sizes).length} 个;超过 ${MAX_LINES} 行的 ${big.length} 个${big.length ? `(${big.map(([f, n]) => `${f} ${n}`).join("、")})` : ""};原生 <button> 共 ${rawButtons} 个`);
if (problems.length) { console.error(problems.map((p) => `✗ ${p}`).join("\n")); console.error(`\n结构检查不通过:${problems.length} 处`); process.exit(1); }
console.log("结构检查通过");
