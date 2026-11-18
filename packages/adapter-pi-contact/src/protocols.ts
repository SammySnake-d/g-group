import type { Model, ProviderStreams } from "@earendil-works/pi-ai";

export type PiProtocol = "anthropic-messages" | "openai-chat" | "openai-responses" | "google-generative-ai";
export type PiAuthHeader = "x-api-key" | "bearer" | "x-goog-api-key";
export type PiModelApi = Exclude<PiProtocol, "openai-chat"> | "openai-completions";
export interface ProtocolSpec {
  readonly api: PiModelApi;
  readonly authHeaders: readonly PiAuthHeader[];
  readonly defaultAuthHeader: PiAuthHeader;
  readonly load: () => ProviderStreams;
}
export const PI_PROTOCOLS: readonly PiProtocol[] = [];
export const PROTOCOLS = {} as Readonly<Record<PiProtocol, ProtocolSpec>>;
export function apiForModel(_model: string): PiProtocol { throw new Error("B4 red stub: apiForModel"); }
export function baseUrlForApi(_protocol: PiProtocol, _url: string): string { throw new Error("B4 red stub: baseUrlForApi"); }
export function protocolForEndpoint(_endpoint: string): PiProtocol | undefined { throw new Error("B4 red stub: protocolForEndpoint"); }
export interface ModelConfig { readonly model: string; readonly provider: string; readonly baseUrl: string; readonly maxTokens: number; readonly contextWindow: number; readonly reasoning?: boolean; readonly sessionAffinity?: boolean }
export function modelForProtocol(_protocol: PiProtocol, _cfg: ModelConfig): Model<PiModelApi> { throw new Error("B4 red stub: codec model"); }
export class ProtocolHealthCache {
  constructor(_opts?: { now?: () => number }) {}
  failure(_baseUrl: string, _model: string, _api: PiProtocol): void { throw new Error("B4 red stub: failure"); }
  success(_baseUrl: string, _model: string, _api: PiProtocol): void { throw new Error("B4 red stub: success"); }
  candidates(_baseUrl: string, _model: string, _apis: readonly PiProtocol[]): readonly PiProtocol[] { throw new Error("B4 red stub: candidates"); }
}
