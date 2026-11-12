// Explicit owning-boundary red scaffold; never a production implementation.
export function createResidentComputeAdapter(_options: unknown) { return { async spawn(_brief: unknown) { return { ok: false, reason: "not implemented" }; } }; }
