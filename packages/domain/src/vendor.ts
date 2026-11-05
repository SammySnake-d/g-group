// 模型 id → 原生研发厂商。认不出就是 unknown;R-01 要求 unknown 一律不能通过独立审查。—— 红提交:空壳
export type Vendor = "anthropic" | "openai" | "google" | "xai" | "zhipu" | "deepseek" | "moonshot" | "unknown";
export function vendorOf(_model: string | undefined): Vendor { throw new Error("未实现"); }
