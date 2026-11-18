import { assembleSpeaking } from "./speaking.ts";
// 给 Electron 主进程(或 UtilityProcess)的一站式启动:按环境选联系人脑子与 Compute,建宿主、服务,并可选挂到 ipcMain。
// 前端只需要:const s = await startServer({ dataDir: app.getPath("userData") }); s.bind(ipcMain);
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_RETRY_POLICY, type ThresholdConfig } from "@g-group/kernel";
import { type ComputeCommands, claudeCompute } from "./compute.ts";
import { deskCompute } from "./fakes.ts";
import { Host } from "./host.ts";
import { DEFAULT_STATE_NOTE_MAX_BYTES, type PiRuntimeOptions } from "./pi-runtime.ts";
import { type IpcMainLike, type Service, bindIpc, createService } from "./service.ts";

export interface StartOptions extends PiRuntimeOptions {
  /** 数据目录:gg.db、插件包、附件、Compute 工作目录都在这下面。 */
  readonly dataDir: string;
  readonly stateNoteMaxBytes?: number | null;
  /** fake:规则替身(不连模型,开发前端用);pi:真实联系人脑子。默认 fake。 */
  readonly mind?: "fake" | "pi";
  /** fake:剧本 Compute(按派的活说话,见 fakes.ts deskCompute);claude:真实 Claude Code CLI。默认 fake。 */
  readonly compute?: "fake" | "claude";
  /** 模型网关环境(ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_DEFAULT_SONNET_MODEL),默认 process.env。 */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** 插件市场目录文件;默认包内示例市场。 */
  readonly catalogFile?: string;
  readonly onReport?: (what: string, detail: unknown) => void;
  /** 给 Compute 的单次输入字节上限(§8.1 待决 13);不给=不设上限 */
  readonly computeInputMaxBytes?: number | null;
  /** compute=claude 时起 Compute 的 claude 命令与汇报工具命令(打包后的桌面应用给自带路径);不给用适配器默认值。 */
  readonly computeCommands?: ComputeCommands;
  /** 卡死阈值的基础层(AC-43 ⑯):不给就是 15 分钟 / 120 秒;用户在设置里、联系人上单独设的覆盖它 */
  readonly runThresholds?: ThresholdConfig;
}
export interface Started {
  readonly host: Host;
  readonly service: Service;
  bind(ipc: IpcMainLike): void;
  close(): Promise<void>;
}

export { DEFAULT_STATE_NOTE_MAX_BYTES };
export const SAMPLE_CATALOG = fileURLToPath(new URL("../catalog/catalog.json", import.meta.url));

export async function startServer(o: StartOptions): Promise<Started> {
  const env = o.env ?? process.env;
  mkdirSync(o.dataDir, { recursive: true });
  const delayMs = Math.min(Math.max(Number(env.GG_MIND_DELAY_MS) || 0, 0), 60_000);
  const { defaultModel: model, ...speaking } = await assembleSpeaking(o.mind ?? "fake", o, env, delayMs);
  const fake = o.compute === "claude" ? null : deskCompute({ stepMs: 300 });
  const compute = fake
    ? () => fake.adapter
    : // 统一重试权(AC-36 F3):CLI 自己对上游错误重试的次数就是宿主的自动重试上限,宿主不再叠加(computeHarnessRetries 同值)
      claudeCompute(env, { CLAUDE_CODE_MAX_RETRIES: String(DEFAULT_RETRY_POLICY.maxAutoRetries) }, o.computeCommands);
  const work = path.join(o.dataDir, "compute");
  const host = new Host({
    file: path.join(o.dataDir, "gg.db"),
    dataDir: o.dataDir,
    catalogFile: o.catalogFile ?? SAMPLE_CATALOG,
    ...speaking,
    compute,
    computeCwd: (taskId) => {
      const d = path.join(work, taskId);
      mkdirSync(d, { recursive: true });
      return d;
    },
    ...(o.onReport ? { onReport: o.onReport } : {}),
    stateNoteMaxBytes: o.stateNoteMaxBytes === undefined ? DEFAULT_STATE_NOTE_MAX_BYTES : o.stateNoteMaxBytes,
    computeHarnessRetries: fake ? 0 : DEFAULT_RETRY_POLICY.maxAutoRetries,
    ...(o.computeInputMaxBytes !== undefined ? { computeInputMaxBytes: o.computeInputMaxBytes } : {}),
    ...(o.runThresholds ? { runThresholds: o.runThresholds } : {}),
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
