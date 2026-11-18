import type { ComputeAdapter } from "@g-group/kernel/compute";

export interface CodexAdapterOptions {
  readonly runner?: { readonly command: string; readonly args?: readonly string[] };
  readonly hostEnv?: Readonly<Record<string, string>>;
  readonly dataDir?: string;
  readonly timeoutMs?: number;
  readonly reapForceMs?: number;
}
const refused = () => ({ ok: false as const, reason: "red stub" });

export function createCodexComputeAdapter(_options: CodexAdapterOptions = {}): ComputeAdapter {
  return {
    capabilities: { inSessionModelSwitch: true, isolation: true },
    spawn: async () => refused(),
    resume: async () => refused(),
    steer: async () => refused(),
    stop: async () => refused(),
    quiesce: async () => ({ ...refused(), remaining: [] }),
    snapshot: refused,
    async *events() {},
    async *activity() {},
    settled: async () => [],
    rejectedReports: () => [],
  };
}
