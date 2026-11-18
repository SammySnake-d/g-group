// Magpie 与兼容网关的模型目录探测(按 Harness 身份查询各自可见的模型目录,避免跨 Harness 伪冲突):
//   - 未指定地址时,从 ~/.config/magpie/settings.json 取得本机 Magpie 端口(默认 3425);
//   - 按 Claude Code (`Bearer magpie-claude`) 与 Codex (`Bearer magpie-codex`) 分别拉取 GET <baseUrl>/v1/models;
//   - 对普通 OpenAI/Anthropic 网关兜底用用户提供的 apiKey 拉取 `/v1/models` 並归一到 {id, label, vendor, harnesses}。
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { HARNESSES, ParamsOf, ResultOf } from "@g-group/api-contract";
import { HostError } from "./db.ts";

type Harness = (typeof HARNESSES)[number];

export interface DiscoveredModel {
  readonly id: string;
  readonly label: string;
  readonly vendor: string;
  readonly harnesses: Harness[];
}

export function inferModelVendor(modelId: string): string {
  const lower = modelId.toLowerCase();
  if (lower.includes("claude")) return "anthropic";
  if (lower.startsWith("gpt-") || /^o\d/.test(lower) || lower.includes("codex")) return "openai";
  if (lower.includes("gemini")) return "google";
  if (lower.includes("deepseek")) return "deepseek";
  if (lower.includes("qwen")) return "qwen";
  if (lower.includes("glm")) return "glm";
  return "custom";
}

function readLocalMagpieUrl(homeDir = os.homedir()): { baseUrl: string; foundConfig: boolean } {
  const xdg = process.env.XDG_CONFIG_HOME || path.join(homeDir, ".config");
  const settingsFile = path.join(xdg, "magpie", "settings.json");
  if (existsSync(settingsFile)) {
    try {
      const parsed = JSON.parse(readFileSync(settingsFile, "utf8")) as { port?: unknown };
      const port = typeof parsed.port === "number" && Number.isInteger(parsed.port) && parsed.port > 0 ? parsed.port : 3425;
      return { baseUrl: `http://127.0.0.1:${port}`, foundConfig: true };
    } catch {
      return { baseUrl: "http://127.0.0.1:3425", foundConfig: true };
    }
  }
  return { baseUrl: "http://127.0.0.1:3425", foundConfig: false };
}

function gatewayUrl(value: string): URL {
  const invalid = () => new HostError("invalid_params", "网关地址必须是没有内嵌凭据的 HTTP(S) URL");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalid();
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) throw invalid();
  return url;
}

async function queryModelsEndpoint(
  baseUrl: string,
  headers: Record<string, string>,
  fetchFn: typeof fetch,
  timeoutMs: number,
): Promise<{ id: string; label?: string }[]> {
  const endpoint = new URL(baseUrl);
  endpoint.hash = "";
  const prefix = endpoint.pathname.replace(/\/+$/, "");
  const candidates = prefix.endsWith("/v1") ? [`${prefix}/models`] : [`${prefix}/v1/models`, `${prefix}/models`];
  for (const candidate of candidates) {
    endpoint.pathname = candidate;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchFn(endpoint.href, { headers, signal: ctrl.signal });
      clearTimeout(timer);
      if (!res.ok) continue;
      const body = (await res.json()) as { data?: Array<{ id?: unknown; display_name?: unknown; magpie_label?: unknown }> };
      if (!Array.isArray(body.data)) continue;
      const out: { id: string; label?: string }[] = [];
      for (const item of body.data) {
        if (typeof item?.id === "string" && item.id.trim()) {
          const label =
            typeof item.magpie_label === "string" && item.magpie_label.trim()
              ? item.magpie_label.trim()
              : typeof item.display_name === "string" && item.display_name.trim()
                ? item.display_name.trim()
                : undefined;
          out.push(label ? { id: item.id.trim(), label } : { id: item.id.trim() });
        }
      }
      return out;
    } catch {
      clearTimeout(timer);
    }
  }
  return [];
}

export async function discoverGatewayCatalog(
  params: ParamsOf<"models.discoverGateway">,
  opts: { fetch?: typeof fetch; homeDir?: string; timeoutMs?: number } = {},
): Promise<ResultOf<"models.discoverGateway">> {
  const fetchFn = opts.fetch ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? 2500;
  const explicit = params.baseUrl?.trim();
  const explicitUrl = explicit ? gatewayUrl(explicit) : undefined;
  const local = !explicitUrl || (params.scanLocal === true && explicitUrl.hostname === "127.0.0.1")
    ? readLocalMagpieUrl(opts.homeDir)
    : undefined;
  const localUrl = local ? gatewayUrl(local.baseUrl) : undefined;
  const targetsLocal = !explicitUrl || explicitUrl.href === localUrl?.href;
  const baseUrl = (explicitUrl ?? localUrl!).href.replace(/\/+$/, "");
  const isMagpieHint = targetsLocal || params.kind === "magpie" || /^https?:\/\/(127\.0\.0\.1|localhost):3425(?:\/|$)/.test(baseUrl);

  const byId = new Map<string, { id: string; label: string; vendor: string; harnesses: Set<Harness> }>();
  const record = (entry: { id: string; label?: string }, harness: Harness) => {
    const cur = byId.get(entry.id) ?? {
      id: entry.id,
      label: entry.label || entry.id,
      vendor: inferModelVendor(entry.id),
      harnesses: new Set<Harness>(),
    };
    if (cur.label === cur.id && entry.label) cur.label = entry.label;
    cur.harnesses.add(harness);
    byId.set(entry.id, cur);
  };

  let detectedMagpie = false;
  if (isMagpieHint) {
    const [claudeList, codexList] = await Promise.all([
      queryModelsEndpoint(baseUrl, { Authorization: "Bearer magpie-claude" }, fetchFn, timeoutMs),
      queryModelsEndpoint(baseUrl, { Authorization: "Bearer magpie-codex" }, fetchFn, timeoutMs),
    ]);
    for (const m of claudeList) record(m, "claude-code");
    for (const m of codexList) record(m, "codex");
    detectedMagpie = claudeList.length > 0 || codexList.length > 0 || (targetsLocal && local?.foundConfig === true);
  }

  if (byId.size === 0) {
    const authHeaders: Record<string, string> = {};
    if (params.apiKey?.trim()) {
      if (params.kind === "anthropic") authHeaders["x-api-key"] = params.apiKey.trim();
      else authHeaders.Authorization = `Bearer ${params.apiKey.trim()}`;
    }
    const generic = await queryModelsEndpoint(baseUrl, authHeaders, fetchFn, timeoutMs);
    for (const m of generic) {
      const v = inferModelVendor(m.id);
      if (v === "openai") record(m, "codex");
      else if (v === "anthropic") record(m, "claude-code");
      else {
        record(m, "claude-code");
        record(m, "codex");
      }
    }
  }

  const models: DiscoveredModel[] = [...byId.values()].map((m) => ({
    id: m.id,
    label: m.label,
    vendor: m.vendor,
    harnesses: (["claude-code", "codex"] as const).filter((h) => m.harnesses.has(h)),
  }));
  const activeHarnesses = (["claude-code", "codex"] as const).filter((h) => models.some((m) => m.harnesses.includes(h)));
  return {
    source: detectedMagpie ? "magpie" : (params.kind ?? "custom"),
    baseUrl,
    detectedMagpie,
    harnesses: activeHarnesses,
    models,
  };
}
