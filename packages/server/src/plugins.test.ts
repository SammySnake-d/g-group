// 插件市场与安装(用户 #719:插件要有市场和安装入口;AC-35 ⑤ 阶段 III 首版只验插件版本号显示与更新)。
// 安装要用户同意清单声明的全部权限;装好的包复制进宿主数据目录;启用插件的命令进 slash 补全;新版本多要权限要重新同意。
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, afterEach, test } from "node:test";
import { gzipSync } from "node:zlib";
import { cleanupKit, closeKitHosts, setup } from "./test-kit.ts";

afterEach(() => closeKitHosts());
after(() => cleanupKit());

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

test("本地目录安装:清单不合格、entry 越界被拒;URL 下载失败如实报不可用", async () => {
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
  assert.deepEqual(!r4.ok && [r4.error.code, r4.error.message], ["unavailable", "下载插件包失败:HTTP 404"]);
  await host.close();
});

/** 手写 ustar 条目,好精确构造应失败的输入(绝对路径、上级目录、链接条目)。type: "0" 文件 / "5" 目录 / "1" 硬链接 / "2" 符号链接 */
function tarEntry(name: string, body: Buffer | null, type: string, linkname = ""): Buffer {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, "utf8");
  h.write("0000644\0", 100);
  h.write("0000000\0", 108);
  h.write("0000000\0", 116);
  h.write(`${(body?.length ?? 0).toString(8).padStart(11, "0")}\0`, 124);
  h.write("00000000000\0", 136);
  h.write("        ", 148);
  h.write(type, 156);
  h.write(linkname, 157, 100, "utf8");
  h.write("ustar\0", 257);
  h.write("00", 263);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  const pad = Buffer.alloc(body ? (512 - (body.length % 512)) % 512 : 0);
  return Buffer.concat([h, body ?? Buffer.alloc(0), pad]);
}
const tgz = (entries: Buffer[]) => gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]));
const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const manifestOf = (id: string, permissions: { key: string; description: string }[] = []) =>
  Buffer.from(JSON.stringify({ id, name: "远程插件", version: "1.2.0", publisher: "far", description: "", kinds: ["data-source"], permissions, entry: "index.mjs" }));
const servedBy = (files: Record<string, Buffer>, fetched: string[] = []) => async (url: string) => {
  fetched.push(url);
  const body = files[url];
  return body ? new Response(new Uint8Array(body)) : new Response("", { status: 404 });
};
const downloadsLeft = (root: string) => {
  const d = path.join(root, "data", "plugin-downloads");
  return existsSync(d) ? readdirSync(d) : [];
};

test("URL 安装:下载 tgz 包、核对 sha256、解包后照常校验清单与权限,来源记为 url", async () => {
  const a = tgz([tarEntry("package/", null, "5"), tarEntry("package/plugin.json", manifestOf("far-a", [{ key: "net:fetch", description: "联网" }]), "0"), tarEntry("package/index.mjs", Buffer.from("export default {};\n"), "0")]);
  const b = tgz([tarEntry("plugin.json", manifestOf("far-b"), "0"), tarEntry("index.mjs", Buffer.from("export default {};\n"), "0")]);
  const fetched: string[] = [];
  const { root, host, svc } = setup({ pluginFetch: servedBy({ "https://plugins.example/a.tgz": a, "https://plugins.example/b.tgz": b }, fetched) });
  const install = (url: string, granted: string[], sha?: string) =>
    svc.handle("plugins.install", { clientActionId: `u-${fetched.length}`, source: sha ? { kind: "url", url, sha256: sha } : { kind: "url", url }, grantedPermissions: granted });
  const wrong = await install("https://plugins.example/a.tgz", ["net:fetch"], "0".repeat(64));
  assert.deepEqual(!wrong.ok && [wrong.error.code, wrong.error.message], ["forbidden", `下载内容的 sha256 是 ${sha256(a)},与给定的不符,不安装`]);
  const noPerm = await install("https://plugins.example/a.tgz", [], sha256(a));
  assert.deepEqual(!noPerm.ok && [noPerm.error.code, noPerm.error.detail], ["forbidden", { missing: ["net:fetch"] }]);
  const ok = await install("https://plugins.example/a.tgz", ["net:fetch"], sha256(a));
  assert.ok(ok.ok, JSON.stringify(ok));
  const v = ok.value as { id: string; version: string; source: string; integrity?: unknown; executable?: boolean; latestVersion: string | null };
  assert.deepEqual([v.id, v.version, v.source, v.integrity, v.executable, v.latestVersion], ["far-a", "1.2.0", "url", { sha256: sha256(a), verified: true }, true, null]);
  assert.equal(readFileSync(path.join(root, "data", "plugins", "far-a", "1.2.0", "index.mjs"), "utf8"), "export default {};\n");
  const unverified = await install("https://plugins.example/b.tgz", []);
  assert.ok(unverified.ok, JSON.stringify(unverified));
  assert.deepEqual((unverified.value as { integrity?: unknown }).integrity, { sha256: sha256(b), verified: false }, "没给 sha256 也记下实际内容 hash,标未核对");
  const missing = await install("https://plugins.example/c.tgz", []);
  assert.deepEqual(!missing.ok && [missing.error.code, missing.error.message], ["unavailable", "下载插件包失败:HTTP 404"]);
  const list = await svc.handle("plugins.list", {});
  assert.deepEqual(list.ok && (list.value as { plugins: { id: string; source: string }[] }).plugins.map((p) => [p.id, p.source]), [["far-a", "url"], ["far-b", "url"]]);
  const up = await svc.handle("plugins.update", { pluginId: "far-a" });
  assert.equal(!up.ok && up.error.code, "invalid_params", "URL 装的插件不在线更新");
  assert.deepEqual(downloadsLeft(root), [], "下载与解包的临时目录已清掉");
  await host.close();
});

test("URL 安装拒绝不安全或不合格的包:绝对路径、上级目录、符号链接、硬链接、超过大小上限、解压炸开、不是 gzip、没有清单", async () => {
  const manifest = tarEntry("plugin.json", manifestOf("bad"), "0");
  const cases: [string, Buffer, string, RegExp][] = [
    ["abs", tgz([manifest, tarEntry("/etc/x", Buffer.from("x"), "0")]), "forbidden", /包里有绝对路径 \/etc\/x/],
    ["up", tgz([manifest, tarEntry("a/../../x", Buffer.from("x"), "0")]), "forbidden", /包里有指向上级目录的路径 a\/\.\.\/\.\.\/x/],
    ["sym", tgz([manifest, tarEntry("link", null, "2", "/tmp")]), "forbidden", /包里有链接条目 link/],
    ["hard", tgz([manifest, tarEntry("hl", null, "1", "plugin.json")]), "forbidden", /包里有链接条目 hl/],
    ["big", tgz([manifest, tarEntry("blob.bin", randomBytes(16 * 1024), "0")]), "invalid_params", /插件包超过 4096 字节上限/],
    ["bomb", tgz([manifest, tarEntry("zeros.bin", Buffer.alloc(256 * 1024), "0")]), "invalid_params", /解压后超过 16384 字节上限/],
    ["plain", Buffer.from("这不是 gzip"), "invalid_params", /只支持 \.tgz/],
    ["nomanifest", tgz([tarEntry("readme.md", Buffer.from("hi"), "0")]), "invalid_params", /包里没有 plugin\.json/],
  ];
  const files = Object.fromEntries(cases.map(([k, body]) => [`https://plugins.example/${k}.tgz`, body]));
  const { root, host, svc } = setup({ pluginFetch: servedBy(files), pluginDownloadMaxBytes: 4096 });
  for (const [k, , code, why] of cases) {
    const r = await svc.handle("plugins.install", { clientActionId: `b-${k}`, source: { kind: "url", url: `https://plugins.example/${k}.tgz` }, grantedPermissions: [] });
    assert.equal(!r.ok && r.error.code, code, k);
    assert.match(!r.ok ? r.error.message : "", why, k);
  }
  const list = await svc.handle("plugins.list", {});
  assert.deepEqual(list.ok && (list.value as { plugins: unknown[] }).plugins, []);
  assert.equal(existsSync(path.join(root, "data", "plugins", "bad")), false);
  assert.deepEqual(downloadsLeft(root), []);
  await host.close();
});
