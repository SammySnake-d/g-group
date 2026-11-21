// Both process entrypoints use the B4 protocol discovery path. Credentials stay in its private closure.
import type { ContactView } from "@g-group/api-contract";
import type { modelConfig } from "@g-group/domain";
import type { ContactMind, ContactCompactor } from "@g-group/kernel";
import { scriptedMind } from "./fakes.ts";
import { makePiRuntime, type PiRuntimeOptions } from "./pi-runtime.ts";
export type SpeakingFactory<T> = (contact: ContactView, speaking: modelConfig.SpeakingSnapshot) => T;
export interface SpeakingAssembly { readonly mind: SpeakingFactory<ContactMind>; readonly compactor?: SpeakingFactory<ContactCompactor>; readonly speakingEndpoint?: () => modelConfig.SpeakingEndpoint; readonly defaultModel?: string; readonly helperReply?: Awaited<ReturnType<typeof makePiRuntime>>["helperReply"] }
export async function assembleSpeaking(kind: string, options: PiRuntimeOptions, env: Readonly<Record<string, string | undefined>>, delayMs = 0): Promise<SpeakingAssembly> {
  if (kind === "pi") return makePiRuntime(options, env);
  if (kind === "fake") return { mind: () => scriptedMind(delayMs ? { delayMs } : {}), ...(options.model ?? env.ANTHROPIC_DEFAULT_SONNET_MODEL ? { defaultModel: options.model ?? env.ANTHROPIC_DEFAULT_SONNET_MODEL! } : {}) };
  throw new Error("unknown speaking runtime");
}
