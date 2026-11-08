// 给 Electron 主进程(或 UtilityProcess)的一站式启动:按环境选联系人脑子与 Compute,建宿主、服务,并可选挂到 ipcMain。
// 前端只需要:const s = await startServer({ dataDir: app.getPath("userData") }); s.bind(ipcMain);
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createComputeAdapter } from "@g-group/adapter-cc-compute";
import type { ContactMind } from "@g-group/kernel";
import { scriptedCompute, scriptedMind } from "./fakes.ts";
import { Host } from "./host.ts";
import { type IpcMainLike, type Service, bindIpc, createService } from "./service.ts";

export interface StartOptions {
  /** 数据目录:gg.db、插件包、附件、Compute 工作目录都在这下面。 */
  readonly dataDir: string;
  /** fake:规则替身(不连模型,开发前端用);pi:真实联系人脑子。默认 fake。 */
  readonly mind?: "fake" | "pi";
  /** fake:剧本 Compute;claude:真实 Claude Code CLI。默认 fake。 */
  readonly compute?: "fake" | "claude";
  /** 模型网关环境(ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_DEFAULT_SONNET_MODEL),默认 process.env。 */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** 插件市场目录文件;默认包内示例市场。 */
  readonly catalogFile?: string;
  readonly onReport?: (what: string, detail: unknown) => void;
}
export interface Started {
  readonly host: Host;
  readonly service: Service;
  bind(ipc: IpcMainLike): void;
  close(): Promise<void>;
}

export const SAMPLE_CATALOG = fileURLToPath(new URL("../catalog/catalog.json", import.meta.url));

export async function startServer(o: StartOptions): Promise<Started> {
  const env = o.env ?? process.env;
  mkdirSync(o.dataDir, { recursive: true });
  const model = env.ANTHROPIC_DEFAULT_SONNET_MODEL;
  let mind: () => ContactMind = () => scriptedMind();
  if (o.mind === "pi") {
    const spec = "@g-group/adapter-pi-contact";
    const mod = (await import(spec)) as { createPiContactMind(opts: Record<string, unknown>): ContactMind };
    const apiKey = env.ANTHROPIC_AUTH_TOKEN ?? env.ANTHROPIC_API_KEY;
    if (!apiKey || !model) throw new Error("mind=pi 需要 ANTHROPIC_AUTH_TOKEN(或 ANTHROPIC_API_KEY)与 ANTHROPIC_DEFAULT_SONNET_MODEL");
    const m = mod.createPiContactMind({ provider: "anthropic", model, baseUrl: env.ANTHROPIC_BASE_URL, apiKey });
    mind = () => m;
  }
  const fake = o.compute === "claude" ? null : scriptedCompute({ stepMs: 300 });
  const compute = fake
    ? () => fake.adapter
    : (m: string) => {
        const hostEnv: Record<string, string> = { ANTHROPIC_MODEL: m };
        for (const k of ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"]) if (env[k]) hostEnv[k] = env[k]!;
        return createComputeAdapter({ hostEnv });
      };
  const work = path.join(o.dataDir, "compute");
  const host = new Host({
    file: path.join(o.dataDir, "gg.db"),
    dataDir: o.dataDir,
    catalogFile: o.catalogFile ?? SAMPLE_CATALOG,
    mind,
    compute,
    computeCwd: (taskId) => {
      const d = path.join(work, taskId);
      mkdirSync(d, { recursive: true });
      return d;
    },
    ...(o.onReport ? { onReport: o.onReport } : {}),
  });
  if (model) host.updateSettings({ defaultSpeakingModel: model, defaultComputeModel: model });
  const service = createService(host);
  return {
    host,
    service,
    bind: (ipc) => bindIpc(ipc, service),
    close: async () => {
      fake?.close();
      await host.close();
    },
  };
}
