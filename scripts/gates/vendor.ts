// 模型 id → 原生研发厂商。认不出就是 unknown,R-01 要求 unknown 一律不通过。
export type Vendor = "anthropic" | "openai" | "google" | "xai" | "zhipu" | "deepseek" | "moonshot" | "unknown";

const TABLE: [RegExp, Vendor][] = [
  [/claude|anthropic|\bopus\b|\bsonnet\b|\bhaiku\b|\bfable\b|mythos/i, "anthropic"],
  [/\bgpt|codex|\bo[134]-|openai/i, "openai"],
  [/gemini|google/i, "google"],
  [/grok|xai/i, "xai"],
  [/\bglm|zhipu/i, "zhipu"],
  [/deepseek/i, "deepseek"],
  [/kimi|moonshot/i, "moonshot"],
];

export function vendorOf(model: string | undefined): Vendor {
  if (!model) return "unknown";
  const hits = new Set(TABLE.filter(([re]) => re.test(model)).map(([, v]) => v));
  return hits.size === 1 ? [...hits][0]! : "unknown";
}
