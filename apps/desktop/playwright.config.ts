import { defineConfig, devices } from "@playwright/test";

// 并行开发时每个工作副本用自己的端口,别复用到别人的预览服务
const PORT = Number(process.env.GG_PW_PORT ?? 5198);

// 本机资源(用户 #1083):只开 1 个 worker,不并行;同一时刻全机只跑一套 e2e(用 verify/serial.mjs 排队)。
// 浏览器用本机 Chrome(需求 v3.20 §8.1 已定 18:不下载 Playwright 浏览器内核),
// 加 --disable-features=MacAppCodeSignClone,不往 $TMPDIR 留 code_sign_clone(开发手册原则 67)。
// 两组测试:
// - renderer:本机 Chrome 打开构建好的渲染层(vite preview),做组件/交互测试和截图走查;
// - electron:真的启动 Electron 壳,核对安全基线和 IPC 校验。
export default defineConfig({
  testDir: "e2e",
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  retries: 0,
  reporter: [["list"]],
  use: { trace: "off" },
  webServer: {
    command: `npx vite preview --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
  projects: [
    {
      name: "renderer",
      testMatch: /.*\.ui\.spec\.ts/,
      use: { ...devices["Desktop Chrome"], channel: "chrome", launchOptions: { args: ["--disable-features=MacAppCodeSignClone"] }, baseURL: `http://localhost:${PORT}`, viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, locale: "zh-CN", timezoneId: "Asia/Shanghai" },
    },
    { name: "electron", testMatch: /.*\.electron\.spec\.ts/ },
  ],
});
