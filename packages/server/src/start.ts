// 给 Electron 主进程(或 UtilityProcess)的一站式启动:按环境选联系人脑子与 Compute,建宿主、服务,并可选挂到 ipcMain。
// 前端只需要:const s = await startServer({ dataDir: app.getPath("userData") }); s.bind(ipcMain);
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_RETRY_POLICY } from "@g-group/kernel";
import { claudeCompute } from "./compute.ts";
import { scriptedCompute } from "./fakes.ts";
import { Host } from "./host.ts";
import { type IpcMainLike, type Service, bindIpc, createService } from "./service.ts";
import { assembleSpeaking } from "./speaking.ts";

export interface StartOptions {
  /** 数据目录:gg.db、插件包、附件、Compute 工作目录都在这下面。 */
  readonly dataDir: string;
  /** fake:规则替身(不连模型,开发前端用);pi:真实联系人脑子。默认 fake。 */
  readonly mind?: "fake" | "pi";
  /** fake:剧本 Compute;claude:真实 Claude Code CLI。默认 fake。 */
  readonly compute?: "fake" | "claude";
  /** 模型网关环境(ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_DEFAULT_SONNET_MODEL,
   *  可选 GG_SPEAKING_MAX_OUTPUT_TOKENS / GG_SPEAKING_CONTEXT_WINDOW),默认 process.env。 */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** 插件市场目录文件;默认包内示例市场。 */
  readonly catalogFile?: string;
  readonly onReport?: (what: string, detail: unknown) => void;
  /** 联系人脑子与压缩器的 HTTP 传输,默认 globalThis.fetch;代理、录制与测试用。 */
  readonly modelFetch?: typeof globalThis.fetch;
  /** 给 Compute 的单次输入字节上限(§8.1 待决 13);不给=不设上限 */
  readonly computeInputMaxBytes?: number | null;
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
  if (o.mind === "pi" && !model) throw new Error("mind=pi 需要 ANTHROPIC_DEFAULT_SONNET_MODEL(联系人默认说话模型)");
  // 说话侧与开发入口 cli.ts 共用同一个装配函数(T-177 G2):端点配置一份、快照按 fingerprint 缓存、密钥只在调用边界解析
  const speaking = await assembleSpeaking({ kind: o.mind ?? "fake", env, ...(o.modelFetch ? { fetch: o.modelFetch } : {}) });
  const fake = o.compute === "claude" ? null : scriptedCompute({ stepMs: 300 });
  const compute = fake
    ? () => fake.adapter
    : // 统一重试权(AC-36 F3):CLI 自己对上游错误重试的次数就是宿主的自动重试上限,宿主不再叠加(computeHarnessRetries 同值)
      claudeCompute(env, { CLAUDE_CODE_MAX_RETRIES: String(DEFAULT_RETRY_POLICY.maxAutoRetries) });
  const work = path.join(o.dataDir, "compute");
  const host = new Host({
    file: path.join(o.dataDir, "gg.db"),
    dataDir: o.dataDir,
    catalogFile: o.catalogFile ?? SAMPLE_CATALOG,
    mind: speaking.mind,
    ...(speaking.compactor ? { compactor: speaking.compactor } : {}),
    speakingEndpoint: () => speaking.endpoint,
    compute,
    computeCwd: (taskId) => {
      const d = path.join(work, taskId);
      mkdirSync(d, { recursive: true });
      return d;
    },
    ...(o.onReport ? { onReport: o.onReport } : {}),
    computeHarnessRetries: fake ? 0 : DEFAULT_RETRY_POLICY.maxAutoRetries,
    ...(o.computeInputMaxBytes !== undefined ? { computeInputMaxBytes: o.computeInputMaxBytes } : {}),
  });
  if (model) host.updateSettings({ defaultSpeakingModel: model, defaultComputeModel: model, confirmAffected: true });
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
