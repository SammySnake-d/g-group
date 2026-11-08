import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// 渲染层构建。Electron 用 app:// 协议从 dist/ 读文件,所以 base 用相对路径。
export default defineConfig({
  base: "./",
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
      "@g-group/ui-core": path.resolve(import.meta.dirname, "../../packages/ui-core/src/index.ts"),
      "@g-group/api-contract": path.resolve(import.meta.dirname, "../../packages/api-contract/src/index.ts"),
    },
  },
  server: { port: 5199, strictPort: true },
  build: { outDir: "dist", emptyOutDir: true },
});
