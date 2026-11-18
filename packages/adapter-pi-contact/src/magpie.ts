import type { ModelUsage } from "@g-group/kernel";
import type { PiContactMindOptions } from "./mind.ts";
import type { PiProtocol, ProtocolHealthCache } from "./protocols.ts";

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
export async function discoverMagpieGateway(_o?: MagpieDiscoveryOptions): Promise<MagpieGateway> { throw new Error("B4 red stub: discovery"); }
export async function probeModelConnection(_o: PiContactMindOptions, _signal?: AbortSignal): Promise<ProbeResult> { throw new Error("B4 red stub: streaming probe"); }
