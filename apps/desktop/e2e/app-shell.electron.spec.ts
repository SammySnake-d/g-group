import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

// 应用壳:没接入模型时整窗先请用户接入,填好后宿主用真模型脑子起来、界面连上;
// 自动更新:从更新地址读 latest-mac.yml → 提示新版本 → 下载并核对 sha512 → 可以重启安装;校验不过就丢掉并说明。
// 全程只点界面。开发模式(没打包)下不真的替换应用,替换那一步在打包后的验收里走。
const appDir = path.resolve(import.meta.dirname, "..");
const baseEnv = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[0] !== "ELECTRON_RUN_AS_NODE" && typeof e[1] === "string"));

function feedServer(files: Record<string, { status?: number; body?: Buffer | string }>): Promise<{ url: string; server: Server }> {
  const server = createServer((req, res) => {
    const f = files[(req.url ?? "/").slice(1)];
    if (!f) { res.writeHead(404).end(); return; }
    res.writeHead(f.status ?? 200).end(f.body ?? "");
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server })));
}

function feedFor(version: string, zip: Buffer, sha512 = createHash("sha512").update(zip).digest("base64")) {
  const entry = (arch: string) => `  - url: g-group-${version}-${arch}-mac.zip\n    sha512: ${sha512}\n    size: ${zip.length}\n`;
  return `version: ${version}\nfiles:\n${entry("arm64")}${entry("x64")}path: g-group-${version}-arm64-mac.zip\nsha512: ${sha512}\nreleaseDate: '2026-11-11T00:00:00.000Z'\n`;
}

test("没接入模型时整窗请用户接入;填好后宿主起来、界面连上,令牌不回传给界面", async () => {
  const userData = mkdtempSync(path.join(tmpdir(), "gg-shell-ud-"));
  const app = await electron.launch({ args: [appDir], cwd: appDir, env: { ...baseEnv, GG_BACKEND: "server", GG_USER_DATA_DIR: userData, GG_COMPUTE: "fake", GG_UPDATE_AUTO: "off" } });
  try {
    const win = await app.firstWindow();
    await expect(win.getByTestId("setup-screen")).toBeVisible();
    await expect(win.getByTestId("rail")).toHaveCount(0);
    await expect(win.getByTestId("setup-save")).toBeDisabled();
    await win.getByTestId("setup-base-url").fill("not a url");
    await win.getByTestId("setup-token").fill("NEUTRAL_FIXTURE_NO_CREDENTIALS");
    await win.getByTestId("setup-model").fill("neutral-model");
    await win.getByTestId("setup-save").click();
    await expect(win.getByTestId("setup-error")).toContainText("网关地址");
    await win.getByTestId("setup-base-url").fill("http://127.0.0.1:9/neutral");
    await win.getByTestId("setup-save").click();
    await expect(win.getByTestId("rail")).toBeVisible({ timeout: 20_000 });
    await expect(win.getByTestId("backend-demo")).toHaveAttribute("data-mode", "connected");
    const view = await win.evaluate(() => (window as unknown as { ggApp: { invoke: (m: string, p: unknown) => Promise<{ ok: boolean; value: unknown }> } }).ggApp.invoke("setup.get", {}));
    expect(view).toMatchObject({ ok: true, value: { gateway: { baseUrl: "http://127.0.0.1:9/neutral", model: "neutral-model", hasToken: true }, backend: { state: "running", mind: "pi", compute: "fake" } } });
    expect(JSON.stringify(view)).not.toContain("NEUTRAL_FIXTURE_NO_CREDENTIALS");
    const cfg = path.join(userData, "gg-config.json");
    expect(statSync(cfg).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(cfg, "utf8")).gateway.model).toBe("neutral-model");
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
});

test("自动更新:提示新版本 → 下载并核对 sha512 → 可以重启安装;校验不过的下载被丢掉并说明;没发布过版本时如实说", async () => {
  const zip = Buffer.from("neutral zip payload for update test ".repeat(4096));
  const good = await feedServer({ "latest-mac.yml": { body: feedFor("9.9.9", zip) }, "g-group-9.9.9-arm64-mac.zip": { body: zip }, "g-group-9.9.9-x64-mac.zip": { body: zip } });
  const userData = mkdtempSync(path.join(tmpdir(), "gg-shell-up-"));
  const launch = (feed: string) => electron.launch({ args: [appDir], cwd: appDir, env: { ...baseEnv, GG_BACKEND: "server", GG_MIND: "fake", GG_COMPUTE: "fake", GG_USER_DATA_DIR: userData, GG_UPDATE_FEED: feed, GG_UPDATE_AUTO: "off" } });
  let app = await launch(good.url);
  try {
    let win = await app.firstWindow();
    await win.getByTestId("nav-settings").click();
    await expect(win.getByTestId("app-version")).toHaveText(/^\d+\.\d+\.\d+$/);
    await win.getByTestId("update-check").click();
    await expect(win.getByTestId("update-toast")).toHaveAttribute("data-phase", "available");
    await expect(win.getByTestId("update-toast")).toContainText("9.9.9");
    await win.getByTestId("update-download").click();
    await expect(win.getByTestId("update-install")).toBeVisible({ timeout: 20_000 });
    await expect(win.getByTestId("update-toast")).toHaveAttribute("data-phase", "ready");
    const log = readFileSync(path.join(userData, "logs", "updater.log"), "utf8");
    expect(log).toContain("sha512 一致");
    await app.close();

    // 校验不过:更新信息里的 sha512 和实际文件对不上
    const bad = await feedServer({ "latest-mac.yml": { body: feedFor("9.9.10", zip, createHash("sha512").update("别的内容").digest("base64")) }, "g-group-9.9.10-arm64-mac.zip": { body: zip }, "g-group-9.9.10-x64-mac.zip": { body: zip } });
    app = await launch(bad.url);
    win = await app.firstWindow();
    await win.getByTestId("nav-settings").click();
    await win.getByTestId("update-check").click();
    await win.getByTestId("update-download").click();
    await expect(win.getByTestId("update-toast")).toHaveAttribute("data-phase", "error", { timeout: 20_000 });
    await expect(win.getByTestId("update-toast")).toContainText("校验不通过");
    await expect(win.getByTestId("update-install")).toHaveCount(0);
    await app.close();
    bad.server.close();

    // 还没发布过版本(更新地址 404)
    const none = await feedServer({});
    app = await launch(none.url);
    win = await app.firstWindow();
    await win.getByTestId("nav-settings").click();
    await win.getByTestId("update-check").click();
    await expect(win.getByTestId("update-note")).toHaveText("还没有发布过新版本");
    await expect(win.getByTestId("update-toast")).toHaveCount(0);
    none.server.close();
  } finally {
    await app.close().catch(() => {});
    good.server.close();
    rmSync(userData, { recursive: true, force: true });
  }
});
