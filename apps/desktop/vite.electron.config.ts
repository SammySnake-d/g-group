import { builtinModules } from "node:module";
import path from "node:path";
import { defineConfig } from "vite";

// Electron 主进程和 preload 打成 CommonJS(沙箱化的 preload 只能是 CJS)。
export default defineConfig({
  publicDir: false,
  resolve: {
    alias: { "@g-group/ui-core": path.resolve(import.meta.dirname, "../../packages/ui-core/src/index.ts") },
  },
  build: {
    outDir: "dist-electron",
    emptyOutDir: true,
    ssr: true,
    target: "node22",
    minify: false,
    rollupOptions: {
      input: { main: "electron/main.ts", preload: "electron/preload.ts" },
      external: ["electron", ...builtinModules, ...builtinModules.map((m) => `node:${m}`)],
      output: { format: "cjs", entryFileNames: "[name].cjs" },
    },
  },
});
