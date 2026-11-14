import { builtinModules } from "node:module";
import path from "node:path";
import { defineConfig } from "vite";

// Electron 主进程、preload、Compute 汇报工具分三次打成单文件 CommonJS:
//   - main:主进程 + 宿主服务(@g-group/server 及其依赖全部打进来,打包后的应用里没有 node_modules);
//   - preload:沙箱化的 preload 只能 require("electron"),不能再 require 拆出去的公共块;
//   - report-mcp:Compute 的 report_progress MCP 服务器,由 claude 命令以子进程拉起(Electron 自带的 Node 执行)。
// GG_ENTRY=preload / report-mcp 选后两个。
const entry = process.env.GG_ENTRY === "preload" ? "preload" : process.env.GG_ENTRY === "report-mcp" ? "report-mcp" : "main";
const input =
  entry === "report-mcp" ? path.resolve(import.meta.dirname, "../../packages/adapter-cc-compute/mcp/report-mcp.mjs") : path.resolve(import.meta.dirname, `electron/${entry}.ts`);
export default defineConfig({
  publicDir: false,
  resolve: {
    alias: {
      "@g-group/ui-core": path.resolve(import.meta.dirname, "../../packages/ui-core/src/index.ts"),
      "@g-group/api-contract": path.resolve(import.meta.dirname, "../../packages/api-contract/src/index.ts"),
    },
  },
  // 依赖都打进来(SSR 构建默认把 node_modules 里的包留作外部 require,打包后的应用里找不到)
  ssr: { noExternal: true },
  build: {
    outDir: "dist-electron",
    emptyOutDir: entry === "main",
    ssr: true,
    target: "node22",
    minify: false,
    rollupOptions: {
      input: { [entry]: input },
      external: ["electron", "node:sqlite", "node:test", "node:sea", ...builtinModules, ...builtinModules.map((m) => `node:${m}`)],
      output: { format: "cjs", entryFileNames: "[name].cjs", inlineDynamicImports: entry !== "main" },
    },
  },
});
