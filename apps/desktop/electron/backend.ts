// 主进程里起宿主服务(@g-group/server:内核 + SQLite + 联系人注意循环 + Compute 适配器),渲染层经 window.gg 按接口合同调用。
//
// 什么时候起、用什么脑子和 Compute:
//   - 打包后的应用默认就起;开发时(electron .)只有 GG_BACKEND=server 才起,否则界面是演示数据(浏览器预览、壳测试用)。
//   - GG_BACKEND=off 一律不起。
//   - 联系人脑子:GG_MIND=fake|pi 优先;不给时,配过模型网关就用 pi(真模型),没配就不起,界面先请用户「接入模型」——
//     不拿规则替身冒充联系人回话。
//   - Compute:GG_COMPUTE=fake|claude 优先,默认 claude(本机的 Claude Code 命令)。
//   - GG_DATA_DIR 数据目录(默认 userData/gg-data);GG_CATALOG 插件市场目录文件。
import { existsSync } from "node:fs";
import path from "node:path";
import { type Started, startServer } from "@g-group/server";
import type { BackendRun } from "../src/api/app-shell-types";
import type { AppConfig } from "./app-config.ts";
import { log } from "./log.ts";
import { which } from "./shell-env.ts";

const pick = <T extends string>(v: string | undefined, allowed: readonly T[]): T | undefined => ((allowed as readonly string[]).includes(v ?? "") ? (v as T) : undefined);

/** 打包后资源在 app.asar 里;要交给子进程执行的文件放在 app.asar.unpacked */
const unpacked = (p: string) => p.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);

/** 汇报工具(report_progress MCP)脚本:构建时打成 dist-electron/report-mcp.cjs,用 Electron 自带的 Node 跑 */
export function reportServerCommand(execPath: string, dir: string) {
  return { command: "/usr/bin/env", args: ["ELECTRON_RUN_AS_NODE=1", execPath, unpacked(path.join(dir, "report-mcp.cjs"))] };
}

export class Backend {
  private started: Started | null = null;
  private run: BackendRun = { state: "off", reason: "还没启动" };
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly o: {
      packaged: boolean;
      userData: string;
      config: AppConfig;
      /** dist-electron 目录(main.cjs 所在) */
      dir: string;
      execPath: string;
      onServer: (s: Started | null) => void;
    },
  ) {}

  status(): BackendRun {
    return this.run;
  }
  claudePath(): string | null {
    return which("claude");
  }

  /** 按当前环境与设置(重新)起宿主;串行执行,前一次关完再起 */
  restart(): Promise<BackendRun> {
    const next = this.chain.then(() => this.doRestart());
    this.chain = next.catch(() => {});
    return next;
  }

  async close(): Promise<void> {
    await this.chain.catch(() => {});
    const s = this.started;
    this.started = null;
    this.o.onServer(null);
    await s?.close();
  }

  private async doRestart(): Promise<BackendRun> {
    const old = this.started;
    this.started = null;
    this.o.onServer(null);
    await old?.close().catch((e) => console.error("[gg-server] 关闭旧宿主出错", e));

    const env = process.env;
    if (env.GG_BACKEND === "off" || (!this.o.packaged && env.GG_BACKEND !== "server")) {
      this.run = { state: "off", reason: "开发模式没开后端(GG_BACKEND=server 才开)" };
      return this.run;
    }
    const gateway = this.o.config.gateway();
    const mind = pick(env.GG_MIND, ["fake", "pi"] as const) ?? (gateway ? "pi" : undefined);
    if (!mind) {
      this.run = { state: "needs-setup" };
      return this.run;
    }
    const compute = pick(env.GG_COMPUTE, ["fake", "claude"] as const) ?? "claude";
    const dataDir = env.GG_DATA_DIR || path.join(this.o.userData, "gg-data");
    const bundled = path.join(process.resourcesPath ?? "", "catalog", "catalog.json");
    const catalogFile = env.GG_CATALOG || (this.o.packaged && existsSync(bundled) ? bundled : path.resolve(this.o.dir, "../../../packages/server/catalog/catalog.json"));
    // 配过网关就用它(联系人与 Compute 同一个网关);没配(只在 GG_MIND 显式给定时)沿用进程环境
    const modelEnv = gateway ? { ANTHROPIC_BASE_URL: gateway.baseUrl, ANTHROPIC_AUTH_TOKEN: gateway.token, ANTHROPIC_DEFAULT_SONNET_MODEL: gateway.model } : env;
    const claude = this.claudePath();
    try {
      this.started = await startServer({
        dataDir,
        catalogFile,
        mind,
        compute,
        env: modelEnv,
        computeCommands: {
          ...(claude ? { runner: { command: claude } } : {}),
          reportServer: reportServerCommand(this.o.execPath, this.o.dir),
        },
        onReport: (what, detail) => console.warn(`[gg-server] ${what}`, detail),
      });
      this.o.onServer(this.started);
      this.run = { state: "running", mind, compute };
      log(`宿主已起:脑子 ${mind},Compute ${compute}${compute === "claude" ? `(${claude ?? "没找到 claude 命令"})` : ""},数据 ${dataDir}`);
    } catch (e) {
      // 起不来就如实回「后端未连接」并带原因,不假装连上
      console.error("[gg-server] 启动失败", e);
      log(`宿主没起来:${e instanceof Error ? e.message : String(e)}`);
      this.run = { state: "failed", reason: e instanceof Error ? e.message : String(e) };
    }
    return this.run;
  }
}
