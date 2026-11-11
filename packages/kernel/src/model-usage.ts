// 模型调用用量回执(AC-39 ⑤⑥、D22 第 3 节第 7 条「每次调用记录 input / cache_read / cache_write」)。
// 适配器每发完一次模型请求,把这一次的用量交给宿主给的回执口;宿主补上种类、联系人、会话、轮次后只追加落表(gg_usage)。
// 内核只定义形状,不做 I/O。线路标识只含服务商、端点主机名和模型:不含密钥,也不含端点路径(本机网关的令牌就在路径里)。

/** 调用种类:round 联系人一轮里的请求;compact 状态笔记补写或缩写;reflect 每轮结束的检查;compute Compute 回报(本片未接) */
export type UsageKind = "round" | "compact" | "reflect" | "compute";
export const USAGE_KINDS: readonly UsageKind[] = Object.freeze(["round", "compact", "reflect", "compute"]);

export interface ModelUsage {
  /** 线路:`服务商|端点主机名|模型`。只取主机名:端口、路径、查询串、用户名口令都不进来,也不含密钥 */
  readonly line: string;
  /** 这次调用里的第几次请求,从 1 起(一轮里模型调了工具会有第 2、3… 次) */
  readonly request: number;
  /** 实际请求体固定前缀(工具声明 + system,即第 1 块)的 sha256 十六进制 */
  readonly prefixHash: string;
  /** 实际请求体里 cache_control 断点的个数(AC-39 ③ 上限 4) */
  readonly breakpoints: number;
  /** 端点回报的未命中输入 token(input_tokens) */
  readonly input: number;
  /** 端点回报的缓存读取 token(cache_read_input_tokens) */
  readonly cacheRead: number;
  /** 端点回报的缓存写入 token(cache_creation_input_tokens) */
  readonly cacheWrite: number;
  readonly output: number;
}

/** 宿主给的用量回执口。同步调用;它出错不能影响模型调用本身(适配器自己兜住) */
export type UsageSink = (usage: ModelUsage) => void;
