import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { normalizeContext, toToolDeclaration } from "@earendil-works/pi-ai";
import type { ModelUsage } from "@g-group/kernel";
import type { PiContactMindOptions } from "./mind.ts";
import { PiContactMindError } from "./errors.ts";
import { apiForModel, PI_PROTOCOLS, type PiProtocol, ProtocolHealthCache, protocolForEndpoint } from "./protocols.ts";
import { describe, resolveOptions, sessionFor, streamRequest, withProtocols } from "./request.ts";

export interface MagpieModel {
  readonly id: string;
  readonly nativeEndpoints?: readonly string[];
  readonly reasoning: boolean;
  readonly toolCall?: boolean;
  readonly supportedParameters: readonly string[];
  readonly protocols: readonly PiProtocol[];
}
export interface MagpieDiscoveryOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly gatewayFile?: string;
  readonly baseUrl?: string;
  readonly apiKey?: string;
  readonly token?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly protocols?: readonly PiProtocol[];
  readonly healthCache?: ProtocolHealthCache;
}
export interface MagpieGateway {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly models: readonly MagpieModel[];
  readonly healthCache: ProtocolHealthCache;
}
export interface ProtocolAttempt { readonly protocol: PiProtocol; readonly error: string }
export type ProbeResult = { readonly ok: true; readonly protocol: PiProtocol; readonly model: string; readonly usage?: ModelUsage }
  | { readonly ok: false; readonly error: string; readonly attempts: readonly ProtocolAttempt[] };

export class MagpieDiscoveryError extends Error {
  readonly identified: boolean;
  constructor(message: string, identified = false) {
    super(message);
    this.name = "MagpieDiscoveryError";
    this.identified = identified;
  }
}

const DEFAULT_GATEWAY = "http://127.0.0.1:3425";
const REASONING_ORDER: readonly PiProtocol[] = ["openai-responses", "openai-chat", "anthropic-messages", "google-generative-ai"];
const object = (x: unknown): Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x) ? x as Record<string, unknown> : {};
const strings = (x: unknown): string[] => Array.isArray(x) ? x.filter((s): s is string => typeof s === "string") : [];

async function localGateway(file: string): Promise<string> {
  try {
    const addr = object(JSON.parse(await readFile(file, "utf8"))).addr;
    if (typeof addr === "string" && addr.trim()) return `http://${addr.trim()}`;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw new MagpieDiscoveryError("Cannot read Magpie gateway.json; set MAGPIE_BASE_URL explicitly");
  }
  return DEFAULT_GATEWAY;
}

export async function discoverMagpieGateway(o: MagpieDiscoveryOptions = {}): Promise<MagpieGateway> {
  const env = o.env ?? process.env;
  const raw = o.baseUrl ?? env.MAGPIE_BASE_URL ?? env.ANTHROPIC_BASE_URL ?? env.OPENAI_BASE_URL
    ?? await localGateway(o.gatewayFile ?? join(homedir(), ".config", "magpie", "gateway.json"));
  let url: URL;
  try { url = new URL(raw); } catch { throw new MagpieDiscoveryError("Invalid Magpie gateway URL; set MAGPIE_BASE_URL"); }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash) throw new MagpieDiscoveryError("Invalid Magpie gateway URL; use an HTTP(S) origin with an optional path");
  const baseUrl = `${url.origin}${url.pathname.replace(/\/+$/, "").replace(/\/v1(?:beta\d*)?$/, "")}`;
  const fetch = o.fetch ?? globalThis.fetch;
  const json = async (path: string, identified: boolean, apiKey?: string): Promise<unknown> => {
    try {
      const r = await fetch(`${baseUrl}${path}`, {
        method: "GET", redirect: "error", signal: AbortSignal.timeout(2500),
        ...(apiKey ? { headers: { authorization: `Bearer ${apiKey}` } } : {}),
      });
      if (!r.ok) throw new MagpieDiscoveryError(`Magpie ${path} returned HTTP ${r.status}`, identified);
      return await r.json() as unknown;
    } catch (e) {
      if (e instanceof MagpieDiscoveryError) throw e;
      throw new MagpieDiscoveryError(`Magpie ${path} is unreachable or did not return JSON`, identified);
    }
  };
  if (object(await json("/api/hello", false)).name !== "magpie") throw new MagpieDiscoveryError("/api/hello did not identify itself as magpie");
  const local = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  const apiKey = o.apiKey ?? o.token ?? env.MAGPIE_API_KEY ?? env.MAGPIE_TOKEN ?? env.ANTHROPIC_AUTH_TOKEN ?? env.ANTHROPIC_API_KEY ?? env.OPENAI_API_KEY ?? (local ? "magpie-g-group" : undefined);
  if (!apiKey?.trim()) throw new MagpieDiscoveryError("Magpie requires a gateway token (MAGPIE_TOKEN)", true);
  const data = object(await json("/v1/models", true, apiKey)).data;
  if (!Array.isArray(data)) throw new MagpieDiscoveryError("Magpie /v1/models did not return data[]", true);
  const models: MagpieModel[] = [];
  const seen = new Set<string>();
  for (const item of data) {
    const m = object(item);
    if (typeof m.id !== "string" || m.id.trim() === "" || seen.has(m.id)) continue;
    seen.add(m.id);
    const endpoints = Object.hasOwn(m, "native_endpoints") ? strings(m.native_endpoints) : undefined;
    const advertised = new Set(endpoints?.map(protocolForEndpoint));
    const order = [...new Set([...(o.protocols ?? []), ...(m.reasoning === true || m.tool_call === true ? REASONING_ORDER : PI_PROTOCOLS)])];
    const protocols = endpoints === undefined ? [apiForModel(m.id)] : order.filter((p) => advertised.has(p));
    models.push(Object.freeze({
      id: m.id, reasoning: m.reasoning === true,
      ...(typeof m.tool_call === "boolean" ? { toolCall: m.tool_call } : {}),
      ...(endpoints ? { nativeEndpoints: Object.freeze(endpoints) } : {}),
      supportedParameters: Object.freeze(strings(m.supported_parameters)),
      protocols: Object.freeze(protocols),
    }));
  }
  if (models.length === 0) throw new MagpieDiscoveryError("Magpie /v1/models has no models", true);
  return Object.freeze({ baseUrl, apiKey, models: Object.freeze(models), healthCache: o.healthCache ?? new ProtocolHealthCache() });
}

const PROBE_TOOL = toToolDeclaration({
  name: "connection_check",
  description: "Confirm the streaming tool-call connection is working.",
  parameters: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false },
});

export async function probeModelConnection(o: PiContactMindOptions, signal = AbortSignal.timeout(120_000)): Promise<ProbeResult> {
  const attempts: ProtocolAttempt[] = [];
  try {
    const cfg = resolveOptions(o, "probe");
    const runCfg = { ...cfg, maxTokens: Math.max(cfg.maxTokens, 8192) };
    const timestamp = Date.now();
    const context = normalizeContext({ messages: [
      { role: "system", content: 'Call connection_check exactly once with {"ok":true}. Do not answer with text.', toolsAdded: [PROBE_TOOL], timestamp },
      { role: "user", content: [{ type: "text", text: "Check this connection now." }], timestamp },
    ] });
    const result = await withProtocols(runCfg, signal, async (attempt) => {
      let usage: ModelUsage | undefined;
      const fail = (why: string) => new PiContactMindError("provider-error", cfg.redact(why));
      const msg = await Promise.resolve().then(() => streamRequest(runCfg, attempt, context, {
        request: 1, sessionId: sessionFor(cfg, "probe", cfg.model), cache: false, options: { signal },
        observeUsage: (u) => { usage = u; },
      }).result()).catch((e: unknown) => { throw fail(describe(e)); });
      if (msg.stopReason === "error" || msg.stopReason === "aborted" || msg.stopReason === "length") throw fail(msg.errorMessage ?? msg.stopReason);
      const calls = msg.content.filter((x) => x.type === "toolCall");
      if (calls.length !== 1 || calls[0]?.name !== "connection_check" || calls[0].arguments.ok !== true) throw fail("Expected one decoded connection_check tool call with ok=true");
      return usage;
    }, (protocol, error) => { attempts.push({ protocol, error }); });
    return { ok: true, protocol: result.protocol, model: cfg.model, ...(result.value ? { usage: result.value } : {}) };
  } catch (e) {
    return { ok: false, error: e instanceof PiContactMindError ? e.message : signal.aborted ? "Connection probe aborted" : "Connection probe failed", attempts };
  }
}
