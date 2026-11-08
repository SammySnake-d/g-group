// 插件市场与安装(用户 #719:插件要有市场和安装入口;AC-35 ⑤ 阶段 III 首版只验插件版本号显示与更新)。
// 安装要用户同意清单声明的全部权限;装好的包复制进宿主数据目录;启用插件的命令进 slash 补全;新版本多要权限要重新同意。
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { scriptedMind } from "./fakes.ts";
import { Host } from "./host.ts";
import { createService } from "./service.ts";

const CATALOG_SRC = fileURLToPath(new URL("../catalog", import.meta.url));
const dir = mkdtempSync(path.join(tmpdir(), "gg-plug-"));
after(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
function setup() {
  const root = path.join(dir, `p${++n}`);
  const catalog = path.join(root, "catalog");
  cpSync(CATALOG_SRC, catalog, { recursive: true });
  const host = new Host({ file: path.join(root, "gg.db"), dataDir: path.join(root, "data"), catalogFile: path.join(catalog, "catalog.json"), mind: () => scriptedMind(), maxDeferMs: 5 });
  return { root, catalog, host, svc: createService(host) };
}

test("市场列出示例插件;按关键词与类型筛选", async () => {
  const { host, svc } = setup();
  const all = await svc.handle("plugins.marketplace", {});
  assert.ok(all.ok);
  assert.deepEqual((all.value as { entries: { id: string; installed: boolean }[] }).entries.map((e) => [e.id, e.installed]), [["rss-reader", false], ["webhook-out", false]]);
  const q = await svc.handle("plugins.marketplace", { query: "webhook" });
  assert.deepEqual(q.ok && (q.value as { entries: { id: string }[] }).entries.map((e) => e.id), ["webhook-out"]);
  const k = await svc.handle("plugins.marketplace", { kind: "data-source" });
  assert.deepEqual(k.ok && (k.value as { entries: { id: string }[] }).entries.map((e) => e.id), ["rss-reader"]);
  await host.close();
});

test("安装:没同意全部权限被拒并列出缺的;同意后装进数据目录、启用、命令进补全;重复安装被拒", async () => {
  const { root, host, svc } = setup();
  const g = host.createGroup("群", []);
  const denied = await svc.handle("plugins.install", { clientActionId: "i1", source: { kind: "marketplace", id: "rss-reader" }, grantedPermissions: [] });
  assert.deepEqual(denied, { ok: false, error: { code: "forbidden", message: "安装需要你同意这些权限:net:fetch", detail: { missing: ["net:fetch"] } } });
  const ok = await svc.handle("plugins.install", { clientActionId: "i2", source: { kind: "marketplace", id: "rss-reader" }, grantedPermissions: ["net:fetch"] });
  assert.ok(ok.ok, JSON.stringify(ok));
  const v = ok.value as { id: string; version: string; enabled: boolean; status: string; commands: string[]; source: string };
  assert.deepEqual([v.id, v.version, v.enabled, v.status, v.commands, v.source], ["rss-reader", "0.1.0", true, "ready", ["rss"], "marketplace"]);
  assert.ok(existsSync(path.join(root, "data", "plugins", "rss-reader", "0.1.0", "plugin.json")));
  const cmds = await svc.handle("commands.list", { roomId: g.id });
  assert.ok(cmds.ok);
  const rss = (cmds.value as { commands: { name: string; source: string; pluginId: string | null }[] }).commands.find((c) => c.name === "rss");
  assert.deepEqual(rss && [rss.source, rss.pluginId], ["plugin", "rss-reader"]);
  const again = await svc.handle("plugins.install", { clientActionId: "i3", source: { kind: "marketplace", id: "rss-reader" }, grantedPermissions: ["net:fetch"] });
  assert.equal(!again.ok && again.error.code, "conflict");
  const market = await svc.handle("plugins.marketplace", {});
  assert.deepEqual(market.ok && (market.value as { entries: { id: string; installed: boolean }[] }).entries.map((e) => e.installed), [true, false]);
  await host.close();
});

test("停用后命令从补全里消失;配置按插件声明保存;卸载删掉安装目录", async () => {
  const { root, host, svc } = setup();
  const g = host.createGroup("群", []);
  await svc.handle("plugins.install", { clientActionId: "i1", source: { kind: "marketplace", id: "webhook-out" }, grantedPermissions: ["net:post"] });
  const events: string[] = [];
  host.bus.subscribe((e) => events.push(e.type));
  await svc.handle("plugins.setEnabled", { pluginId: "webhook-out", enabled: false });
  const cmds = await svc.handle("commands.list", { roomId: g.id });
  assert.ok(cmds.ok && !(cmds.value as { commands: { name: string }[] }).commands.some((c) => c.name === "push"));
  const cfg = await svc.handle("plugins.configure", { pluginId: "webhook-out", config: { url: "https://example.com/hook" } });
  assert.ok(cfg.ok);
  assert.deepEqual((cfg.value as { config: unknown }).config, { url: "https://example.com/hook" });
  const un = await svc.handle("plugins.uninstall", { pluginId: "webhook-out" });
  assert.ok(un.ok);
  assert.equal(existsSync(path.join(root, "data", "plugins", "webhook-out")), false);
  assert.deepEqual(events, ["plugin.updated", "commands.changed", "plugin.updated", "plugin.removed", "commands.changed"]);
  await host.close();
});

test("版本更新:市场出了新版本列表显示可更新;新版本多要权限必须重新同意", async () => {
  const { catalog, host, svc } = setup();
  await svc.handle("plugins.install", { clientActionId: "i1", source: { kind: "marketplace", id: "rss-reader" }, grantedPermissions: ["net:fetch"] });
  const mf = path.join(catalog, "rss-reader", "plugin.json");
  const m = JSON.parse(readFileSync(mf, "utf8"));
  writeFileSync(mf, JSON.stringify({ ...m, version: "0.2.0", permissions: [...m.permissions, { key: "notify", description: "发系统通知" }] }));
  const got = await svc.handle("plugins.get", { pluginId: "rss-reader" });
  assert.deepEqual(got.ok && [(got.value as { version: string }).version, (got.value as { latestVersion: string }).latestVersion], ["0.1.0", "0.2.0"]);
  const need = await svc.handle("plugins.update", { pluginId: "rss-reader" });
  assert.deepEqual(!need.ok && need.error.detail, { missing: ["notify"] });
  const up = await svc.handle("plugins.update", { pluginId: "rss-reader", grantedPermissions: ["notify"] });
  assert.ok(up.ok);
  assert.deepEqual([(up.value as { version: string }).version, (up.value as { latestVersion: string | null }).latestVersion], ["0.2.0", null]);
  const same = await svc.handle("plugins.update", { pluginId: "rss-reader" });
  assert.equal(!same.ok && same.error.message, "已是最新版本 0.2.0");
  await host.close();
});

test("本地目录安装:清单不合格、entry 越界被拒;URL 安装如实报未接入", async () => {
  const { root, host, svc } = setup();
  const bad = path.join(root, "bad");
  mkdirSync(bad);
  writeFileSync(path.join(bad, "plugin.json"), JSON.stringify({ id: "Bad Id", name: "x", version: "1", publisher: "p", description: "", kinds: [], permissions: [] }));
  const r1 = await svc.handle("plugins.install", { clientActionId: "l1", source: { kind: "local-path", path: bad }, grantedPermissions: [] });
  assert.equal(!r1.ok && r1.error.code, "invalid_params");
  assert.match(!r1.ok ? r1.error.message : "", /plugin\.json 不合格:id: 格式不符.*version: 格式不符/);
  const esc = path.join(root, "esc");
  mkdirSync(esc);
  writeFileSync(path.join(esc, "plugin.json"), JSON.stringify({ id: "esc", name: "x", version: "1.0.0", publisher: "p", description: "", kinds: ["ui-extension"], permissions: [], entry: "../../etc/passwd" }));
  const r2 = await svc.handle("plugins.install", { clientActionId: "l2", source: { kind: "local-path", path: esc }, grantedPermissions: [] });
  assert.equal(!r2.ok && r2.error.message, "entry 不能指到包目录外");
  const good = path.join(root, "good");
  mkdirSync(good);
  writeFileSync(path.join(good, "plugin.json"), JSON.stringify({ id: "good", name: "好插件", version: "1.0.0", publisher: "me", description: "", kinds: ["ui-extension"], permissions: [] }));
  const r3 = await svc.handle("plugins.install", { clientActionId: "l3", source: { kind: "local-path", path: good }, grantedPermissions: [] });
  assert.ok(r3.ok);
  assert.equal((r3.value as { source: string }).source, "local-path");
  const r4 = await svc.handle("plugins.install", { clientActionId: "l4", source: { kind: "url", url: "https://example.com/p.tgz" }, grantedPermissions: [] });
  assert.equal(!r4.ok && r4.error.code, "unavailable");
  await host.close();
});
