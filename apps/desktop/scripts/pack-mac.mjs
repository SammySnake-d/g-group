#!/usr/bin/env node
// 打 macOS 安装包:先构建(渲染层 + 主进程 + 汇报工具),再在干净的暂存目录里交给 electron-builder。
// 暂存目录只放运行要的东西(dist、dist-electron、插件示例目录、精简的 package.json),不带 node_modules:
// 主进程与宿主已由 vite 打成单文件,应用里不需要任何运行时依赖。
//   node scripts/pack-mac.mjs                构建 + 打包(dmg + zip + latest-mac.yml,输出在 release/)
//   node scripts/pack-mac.mjs --skip-build   dist/ 与 dist-electron/ 已构建好(例如在别的机器上构建)时只打包
//   GG_VERSION=0.1.1 node scripts/pack-mac.mjs   临时改版本号打包(验收自动更新用;正式发版改 package.json 的 version)
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const here = path.resolve(import.meta.dirname, "..");
const repo = path.resolve(here, "../..");
const pkg = JSON.parse(readFileSync(path.join(here, "package.json"), "utf8"));
const version = process.env.GG_VERSION || pkg.version;
const run = (cmd, args, cwd = here) => execFileSync(cmd, args, { cwd, stdio: "inherit", env: { ...process.env, ELECTRON_RUN_AS_NODE: "" } });

if (!process.argv.includes("--skip-build")) {
  run("npm", ["run", "build:renderer"]);
  run("npm", ["run", "build:electron"]);
}
for (const f of ["dist/index.html", "dist-electron/main.cjs", "dist-electron/preload.cjs", "dist-electron/report-mcp.cjs"]) {
  if (!existsSync(path.join(here, f))) throw new Error(`缺 ${f},先构建`);
}

const stage = path.join(here, "release-stage");
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
cpSync(path.join(here, "dist"), path.join(stage, "dist"), { recursive: true });
cpSync(path.join(here, "dist-electron"), path.join(stage, "dist-electron"), { recursive: true, filter: (s) => !s.endsWith(".map") });
cpSync(path.join(repo, "packages/server/catalog"), path.join(stage, "catalog"), { recursive: true });
writeFileSync(
  path.join(stage, "package.json"),
  JSON.stringify({ name: "g-group", productName: "g-group", version, description: pkg.description, author: "SammySnake-d", main: "dist-electron/main.cjs", license: "UNLICENSED" }, null, 2),
);
const cfg = readFileSync(path.join(here, "electron-builder.yml"), "utf8")
  .replace("from: ../../packages/server/catalog", "from: catalog")
  .replace("output: release", `output: ${JSON.stringify(path.join(here, "release"))}`);
writeFileSync(path.join(stage, "electron-builder.yml"), cfg);
run("npx", ["-y", "electron-builder@26.18.0", "--mac", "--publish", "never", "--config", "electron-builder.yml"], stage);
console.log(`\n已打包 g-group ${version}:${path.join(here, "release")}`);
