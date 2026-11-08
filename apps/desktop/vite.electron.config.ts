import { builtinModules } from "node:module";
import path from "node:path";
import { defineConfig } from "vite";

// Electron 主进程和 preload 分两次打成单文件 CommonJS:沙箱化的 preload 只能 require("electron"),
// 不能再 require 拆出去的公共块,所以每个入口各自打成一个自包含文件。GG_ENTRY=preload 打 preload。
const entry = process.env.GG_ENTRY === "preload" ? "preload" : "main";
export default defineConfig({
  publicDir: false,
  resolve: {
    alias: {
      "@g-group/ui-core": path.resolve(import.meta.dirname, "../../packages/ui-core/src/index.ts"),
      "@g-group/api-contract": path.resolve(import.meta.dirname, "../../packages/api-contract/src/index.ts"),
    },
  },
  build: {
    outDir: "dist-electron",
    emptyOutDir: entry === "main",
    ssr: true,
    target: "node22",
    minify: false,
    rollupOptions: {
      input: { [entry]: `electron/${entry}.ts` },
      external: ["electron", ...builtinModules, ...builtinModules.map((m) => `node:${m}`)],
      output: { format: "cjs", entryFileNames: "[name].cjs" },
    },
  },
});
