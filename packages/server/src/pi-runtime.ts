import { modelConfig } from "@g-group/domain";
import type { PiContactMindOptions, PiProtocol } from "@g-group/adapter-pi-contact";
import type { ContactView } from "@g-group/api-contract";
import type { ContactCompactor, ContactMind } from "@g-group/kernel";

export const DEFAULT_STATE_NOTE_MAX_BYTES = 8192;

export interface PiRuntimeOptions {
  readonly api?: PiProtocol;
  readonly protocols?: readonly PiProtocol[];
  readonly magpie?: boolean;
  readonly model?: string;
  readonly fetch?: typeof globalThis.fetch;
}

/** Shared by Electron and CLI; resolve once, select an exact model at the start of each turn. */
export async function makePiRuntime(o: PiRuntimeOptions, env: Readonly<Record<string, string | undefined>>) {
  const pi = await import("@g-group/adapter-pi-contact");
  const bad = (why: string): never => { throw new Error(`mind=pi: ${why}`); };
  const api = o.api === undefined ? undefined : pi.protocolFor(o.api, bad);
  const ordered = o.protocols?.map((p) => pi.protocolFor(p, bad));
  if (ordered?.length === 0) bad("protocols cannot be empty");
  const preferOpenAI = (api ?? ordered?.[0])?.startsWith("openai-") ?? (!!env.OPENAI_API_KEY && !env.ANTHROPIC_AUTH_TOKEN && !env.ANTHROPIC_API_KEY);
  const model = o.model ?? (preferOpenAI ? env.OPENAI_MODEL ?? env.ANTHROPIC_DEFAULT_SONNET_MODEL : env.ANTHROPIC_DEFAULT_SONNET_MODEL ?? env.OPENAI_MODEL);
  const directKey = preferOpenAI ? env.OPENAI_API_KEY ?? env.ANTHROPIC_AUTH_TOKEN ?? env.ANTHROPIC_API_KEY : env.ANTHROPIC_AUTH_TOKEN ?? env.ANTHROPIC_API_KEY ?? env.OPENAI_API_KEY;
  const endpoint = preferOpenAI ? env.OPENAI_BASE_URL ?? env.ANTHROPIC_BASE_URL : env.ANTHROPIC_BASE_URL ?? env.OPENAI_BASE_URL;
  const magpieRequired = o.magpie === true || !!env.MAGPIE_BASE_URL || !directKey || !model;
  const healthCache = new pi.ProtocolHealthCache();
  const fetch = o.fetch ? { fetch: o.fetch } : {};
  let gateway: Awaited<ReturnType<typeof pi.discoverMagpieGateway>> | undefined;
  if (o.magpie !== false && (magpieRequired || endpoint)) {
    try {
      gateway = await pi.discoverMagpieGateway({ env, ...(env.MAGPIE_BASE_URL || endpoint ? { baseUrl: env.MAGPIE_BASE_URL ?? endpoint! } : {}), ...fetch, healthCache, ...(ordered ? { protocols: ordered } : {}) });
    } catch (e) {
      if (magpieRequired || (e instanceof pi.MagpieDiscoveryError && e.identified)) {
        const detail = e instanceof pi.MagpieDiscoveryError ? e.message : "gateway discovery failed";
        bad(`${detail}. Start Magpie / set MAGPIE_BASE_URL, or configure a provider key and model.`);
      }
    }
  }
  const configuredProtocols = api && !ordered ? [api] : ordered ? [...new Set([...(api ? [api] : []), ...ordered])] : undefined;
  const advertised = new Map(gateway?.models.map((x) => [x.id, x]));
  const choose = (m: NonNullable<typeof gateway>["models"][number]) => configuredProtocols
    ? configuredProtocols.filter((p) => m.nativeEndpoints === undefined || m.protocols.includes(p))
    : m.protocols;
  const defaultModel = model ?? gateway?.models.find((m) => m.toolCall !== false && choose(m).length > 0)?.id;
  if (!defaultModel || (!gateway && !directKey)) return bad("configure a provider key and model, or enable a Magpie gateway advertising a tool-capable model");
  const options = (id: string): PiContactMindOptions => {
    if (gateway) {
      const selected = advertised.get(id);
      if (!selected) throw new pi.PiContactMindError("invalid-options", "Magpie did not advertise the selected model; update speakingModel or the gateway roster");
      const protocols = choose(selected);
      if (protocols.length === 0) throw new pi.PiContactMindError("invalid-options", "Magpie did not advertise a supported codec for the selected model");
      return { provider: "magpie", model: id, baseUrl: gateway.baseUrl, apiKey: gateway.apiKey, protocols, healthCache, reasoning: selected.reasoning,
        ...(selected.reasoning ? { maxTokens: 8192 } : {}),
        ...(protocols.includes("anthropic-messages") ? { authHeader: "bearer" } : {}), ...fetch };
    }
    const protocols = configuredProtocols ?? [preferOpenAI ? "openai-chat" : "anthropic-messages"];
    const defaults: Readonly<Record<PiProtocol, string>> = {
      "anthropic-messages": "https://api.anthropic.com", "openai-chat": "https://api.openai.com", "openai-responses": "https://api.openai.com", "google-generative-ai": "https://generativelanguage.googleapis.com/v1beta",
    };
    return { provider: preferOpenAI ? "openai" : "anthropic", model: id, baseUrl: endpoint ?? defaults[protocols[0]!], apiKey: directKey!, protocols, healthCache,
      ...(env.ANTHROPIC_AUTH_TOKEN === directKey && protocols.includes("anthropic-messages") ? { authHeader: "bearer" } : {}), ...fetch };
  };
  // Validate the configured/default model before opening a Host. Later unavailable models are surfaced by the Host when invoked.
  options(defaultModel);
  function forModel<T>(create: (opts: PiContactMindOptions) => T) {
    const cache = new Map<string, T>();
    return (_c: ContactView, snapshot: modelConfig.SpeakingSnapshot): T => {
      let instance = cache.get(snapshot.fingerprint);
      if (instance === undefined) {
        const base = options(snapshot.model);
        instance = create({ ...base, maxTokens: Math.max(snapshot.maxOutputTokens, base.reasoning ? 8192 : 1), contextWindow: snapshot.contextWindow });
        cache.set(snapshot.fingerprint, instance);
      }
      return instance;
    };
  }
  const mind: (c: ContactView, s: modelConfig.SpeakingSnapshot) => ContactMind = forModel(pi.createPiContactMind);
  const compactor: (c: ContactView, s: modelConfig.SpeakingSnapshot) => ContactCompactor = forModel(pi.createPiCompactor);
  const positive = (key: string, fallback: number) => { const raw = env[key]; if (raw === undefined) return fallback; const n = Number(raw); if (!/^\d+$/.test(raw) || !Number.isSafeInteger(n) || n < 1) throw new Error(`invalid speaking option ${key}`); return n; };
  // The public endpoint is an origin only: gateway paths may themselves contain tokens.
  const selected = options(defaultModel);
  const endpointConfig = Object.freeze({ provider: selected.provider, baseUrl: new URL(selected.baseUrl!).origin, authRef: "none", maxOutputTokens: positive("GG_SPEAKING_MAX_OUTPUT_TOKENS", selected.maxTokens ?? 4096), contextWindow: positive("GG_SPEAKING_CONTEXT_WINDOW", 200000), reasoning: Object.freeze({}) });
  modelConfig.checkSpeakingEndpoint(endpointConfig);
  return { mind, compactor, defaultModel, speakingEndpoint: () => endpointConfig };
}
