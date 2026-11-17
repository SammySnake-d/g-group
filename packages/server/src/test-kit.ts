// 插件相关测试共用的宿主搭建(plugins.test.ts、plugin-runtime.test.ts):每次一个独立数据目录、复制一份示例市场、
// 固定的宿主时钟、默认不连网的下载函数。测试自己负责关宿主(closeKitHosts 或 host.close)和删临时目录(cleanupKit)。
// 不在包入口导出,只给测试用。
import { cpSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scriptedMind } from "./fakes.ts";
import { Host, type HostOptions } from "./host.ts";
import { createService } from "./service.ts";

const CATALOG_SRC = fileURLToPath(new URL("../catalog", import.meta.url));
/** 宿主时钟固定在这一刻:外部事件的 receivedAt 应等于它 */
export const KIT_NOW_MS = Date.parse("2026-11-09T01:00:00.000Z");
/** 测试不连网:下载一律 404,要下载的用例自己给 pluginFetch */
export const NO_NET = async () => new Response("", { status: 404 });

let dir: string | null = null;
let n = 0;
const live: Host[] = [];

export function setup(extra: Partial<HostOptions> = {}) {
  dir ??= realpathSync(mkdtempSync(path.join(tmpdir(), "gg-plugkit-")));
  const root = path.join(dir, `p${++n}`);
  const catalog = path.join(root, "catalog");
  cpSync(CATALOG_SRC, catalog, { recursive: true });
  const host = new Host({
    file: path.join(root, "gg.db"),
    dataDir: path.join(root, "data"),
    catalogFile: path.join(catalog, "catalog.json"),
    mind: () => scriptedMind(),
    maxDeferMs: 5,
    clockMs: () => KIT_NOW_MS,
    pluginFetch: NO_NET,
    ...extra,
  });
  live.push(host);
  return { root, catalog, host, svc: createService(host) };
}
/** 关掉还没被测试自己关的宿主(连带插件子进程)。 */
export async function closeKitHosts() {
  for (const h of live.splice(0)) await h.close();
}
/** 删掉本进程建的临时目录。 */
export function cleanupKit() {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
}
