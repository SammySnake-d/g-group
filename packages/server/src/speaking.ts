// 说话侧装配(T-177 G2 = D;AC-32 ③)— 红提交空壳
import type { ContactView } from "@g-group/api-contract";
import { modelConfig } from "@g-group/domain";
import type { ContactCompactor, ContactMind } from "@g-group/kernel";
import { scriptedMind } from "./fakes.ts";

type Env = Readonly<Record<string, string | undefined>>;
export type SpeakingFactory<T> = (contact: ContactView, speaking: modelConfig.EffectiveSpeakingConfig) => T;
export interface PiSpeakingModule {
  createPiContactMind(opts: Record<string, unknown>): ContactMind;
  createPiCompactor(opts: Record<string, unknown>): ContactCompactor;
}
export interface SpeakingAssemblyOptions {
  readonly kind: string;
  readonly env: Env;
  readonly fetch?: typeof globalThis.fetch;
  readonly load?: () => Promise<PiSpeakingModule>;
}
export interface SpeakingAssembly {
  readonly endpoint: modelConfig.SpeakingEndpoint;
  readonly mind: SpeakingFactory<ContactMind>;
  readonly compactor?: SpeakingFactory<ContactCompactor>;
}
export function speakingEndpointFromEnv(_env: Env): modelConfig.SpeakingEndpoint {
  return modelConfig.DEFAULT_SPEAKING_ENDPOINT;
}
export async function assembleSpeaking(_o: SpeakingAssemblyOptions): Promise<SpeakingAssembly> {
  return { endpoint: modelConfig.DEFAULT_SPEAKING_ENDPOINT, mind: () => scriptedMind() };
}
