// 应用自己的设置:模型网关(地址、令牌、模型)与更新地址,存在 userData/gg-config.json(权限 600)。
// 令牌不用钥匙串(safeStorage):没有开发者证书时应用是临时签名,每次更新签名都变,钥匙串会每次弹窗要授权。
// 有了开发者证书后改成 safeStorage。令牌只进不出:渲染层只拿到 hasToken。
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { GatewayView, SetupInput } from "../src/api/app-shell-types";

export interface Gateway {
  baseUrl: string;
  model: string;
  token: string;
}
interface Stored {
  gateway?: Gateway;
  updateFeed?: string;
}

export class AppConfig {
  readonly file: string;
  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, "gg-config.json");
  }
  private read(): Stored {
    if (!existsSync(this.file)) return {};
    try {
      const v = JSON.parse(readFileSync(this.file, "utf8")) as unknown;
      return v && typeof v === "object" && !Array.isArray(v) ? (v as Stored) : {};
    } catch {
      return {};
    }
  }
  private write(s: Stored) {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(s, null, 2), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.file);
  }
  gateway(): Gateway | null {
    const g = this.read().gateway;
    return g && typeof g.baseUrl === "string" && typeof g.model === "string" && typeof g.token === "string" && g.baseUrl && g.model && g.token ? g : null;
  }
  gatewayView(): GatewayView | null {
    const g = this.read().gateway;
    if (!g) return null;
    return { baseUrl: g.baseUrl ?? "", model: g.model ?? "", hasToken: !!g.token };
  }
  /** 校验后保存;不合格抛 Error(人话原因) */
  saveGateway(input: SetupInput): Gateway {
    const baseUrl = String(input.baseUrl ?? "").trim().replace(/\/+$/, "");
    const model = String(input.model ?? "").trim();
    const token = typeof input.token === "string" && input.token.trim() ? input.token.trim() : (this.read().gateway?.token ?? "");
    let u: URL;
    try {
      u = new URL(baseUrl);
    } catch {
      throw new Error("网关地址不是有效的网址,应以 http:// 或 https:// 开头");
    }
    if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("网关地址应以 http:// 或 https:// 开头");
    if (!model) throw new Error("请填模型名");
    if (model.length > 200 || /\s/.test(model)) throw new Error("模型名不能含空格,长度不超过 200");
    if (!token) throw new Error("请填令牌");
    const g = { baseUrl, model, token };
    this.write({ ...this.read(), gateway: g });
    return g;
  }
  updateFeed(): string | undefined {
    const f = this.read().updateFeed;
    return typeof f === "string" && f ? f : undefined;
  }
}
