// 主进程里起宿主服务(dev/integration 的 @g-group/server:内核 + SQLite + 联系人注意循环 + Compute 适配器)。
// 由环境变量决定接不接、用什么脑子和 Compute,默认不接——界面层的真实数据接线做完前,接上反而会让演示界面和真实数据混在一起。
//   GG_BACKEND=server       接上宿主服务
//   GG_MIND=fake|pi         联系人脑子:规则替身 / 真实 pi(需 ANTHROPIC_* 环境变量)
//   GG_COMPUTE=fake|claude  Compute:剧本 / 真实 Claude Code CLI
//   GG_DATA_DIR             数据目录(默认 userData/gg-data),测试用临时目录隔离
//   GG_CATALOG              插件市场目录文件(默认仓库里 packages/server/catalog/catalog.json)
import path from "node:path";
import { type Started, startServer } from "@g-group/server";

const pick = <T extends string>(v: string | undefined, allowed: readonly T[], fallback: T): T => (allowed as readonly string[]).includes(v ?? "") ? (v as T) : fallback;

export async function startBackend(userData: string): Promise<Started | null> {
  if (process.env.GG_BACKEND !== "server") return null;
  const dataDir = process.env.GG_DATA_DIR || path.join(userData, "gg-data");
  // dist-electron/main.cjs → 仓库根;打包发布时改成随应用分发的目录
  const catalogFile = process.env.GG_CATALOG || path.resolve(__dirname, "../../../packages/server/catalog/catalog.json");
  try {
    return await startServer({
      dataDir,
      catalogFile,
      mind: pick(process.env.GG_MIND, ["fake", "pi"] as const, "fake"),
      compute: pick(process.env.GG_COMPUTE, ["fake", "claude"] as const, "fake"),
      onReport: (what, detail) => console.warn(`[gg-server] ${what}`, detail),
    });
  } catch (e) {
    // 起不来就如实保持「后端未连接」,界面标「演示」,不假装连上
    console.error("[gg-server] 启动失败", e);
    return null;
  }
}
