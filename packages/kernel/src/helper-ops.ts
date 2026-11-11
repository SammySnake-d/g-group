// Helper 的软件操作能力清单(U04「手动能做的,helper 也能做(在权限内)」;U05 普通联系人不加载;D07.0 / D28.1 / AC-52)。
// 清单 = 服务接口(@g-group/api-contract 的方法表)的受控子集,纯数据,是 Helper 专属 MCP、CLI、skill 共用的唯一业务能力来源:
//   每项一个服务方法,带种类、参数 JSON Schema 与中文说明。
//   kind = read          只读;
//   kind = write         改状态,可撤回或可再改;
//   kind = irreversible  不可逆或授权类(删除、卸载、回退、授予插件权限等)。代码不设确认门禁(软提示不做成功能,DM#2565):
//                        工具说明与 skill 写明「先跟用户说清,等用户本人同意再调」。
// 排除清单写明哪些方法按权限不给 Helper(以用户身份发言、验收与授权只来自用户本人等,U99/AC-20/AC-28),每条带理由;服务层据此拒收。
// 清单与服务方法表一一对账由服务层测试做(内核不依赖接口合同包);这里只定义形状与端口,不做 I/O。

export type HelperOpKind = "read" | "write" | "irreversible";
export type JsonSchema = Readonly<Record<string, unknown>>;
export interface HelperOp {
  /** 工具名(^[a-zA-Z0-9_-]{1,64}$);一般是方法名把「.」换成「_」,messages.list 叫 read_room。 */
  readonly name: string;
  /** 对应的服务方法(「域.动作」)。 */
  readonly method: string;
  readonly kind: HelperOpKind;
  /** 一句话中文标签,用在操作记录里。 */
  readonly label: string;
  /** 给模型看的中文说明。 */
  readonly description: string;
  /** 参数 JSON Schema(type: object)。clientActionId 不在这里,由宿主按每次调用生成。 */
  readonly params: JsonSchema;
}
export interface HelperExclusion {
  readonly method: string;
  readonly reason: string;
}

/** Helper 的能力清单(封闭)。空壳:待实现。 */
export const HELPER_OPS: readonly HelperOp[] = Object.freeze([]);
/** 按权限不给 Helper 的服务方法。空壳:待实现。 */
export const HELPER_EXCLUDED: readonly HelperExclusion[] = Object.freeze([]);
/** 工具说明。空壳。 */
export function toolDescription(_op: HelperOp): string {
  return "";
}
/** 按工具名找清单项。空壳。 */
export function helperOp(_name: string): HelperOp | null {
  return null;
}
/** 排除清单查询。空壳。 */
export function helperExclusion(_name: string): HelperExclusion | null {
  return null;
}

// ---------------------------------------------------------------- Helper 脑子的端口
/** 这一次叫 Helper 的入口与路由(routeHelper 的结果)。 */
export interface HelperRouteInfo {
  readonly entry: "global" | "sidebar" | "mention";
  /** 侧栏 / @ 的当前聊天;全局为 null。 */
  readonly contextRoomId: string | null;
  /** @ 时回复的那条消息 seq;其余为 null。 */
  readonly replyToSeq: number | null;
}
export interface HelperMindInput {
  /** Helper 用的模型:全局默认说话模型(U70 只在联系人与 Compute 两处配模型,不另设 Helper 模型槽)。 */
  readonly model: string;
  readonly route: HelperRouteInfo;
  /** 用户这句话。 */
  readonly text: string;
  /** 按入口给的上下文:全局为空串(不带任何聊天);侧栏 / @ 是当前聊天的资料与最近消息。 */
  readonly context: string;
  /** 同一入口此前的问答(全局面板或这个侧栏的记录,不是聊天消息);@ 入口为空。 */
  readonly history: readonly { readonly role: "user" | "helper"; readonly text: string }[];
  /** Helper 的 skill 原文(何时、如何用这些工具),进系统提示。 */
  readonly skill: string;
}
export interface HelperToolResult {
  readonly ok: boolean;
  /** 回给模型的结果文字(JSON 或错误说明)。 */
  readonly text: string;
}
/**
 * MCP 客户端口(JSON-RPC 2.0):request 发一个带 id 的请求,返回 result;服务端回 error 时抛 McpError。
 * 宿主进程内用内存传输接 Helper MCP 服务(memoryMcpClient);工具清单从 tools/list 来,调用走 tools/call。
 */
export interface McpClient {
  request(method: string, params?: unknown): Promise<unknown>;
}
export interface HelperMindOutput {
  /** 给用户的文字回复。 */
  readonly reply: string;
  /** 本次的工具调用记录(按顺序)。 */
  readonly calls: readonly { readonly name: string; readonly args: unknown; readonly ok: boolean; readonly text: string }[];
}
export interface HelperMind {
  run(input: HelperMindInput, signal: AbortSignal, mcp: McpClient): Promise<HelperMindOutput>;
}

/** Helper 的系统提示与用户消息。空壳。 */
export function renderHelperPrompt(_input: HelperMindInput): { system: string; user: string } {
  return { system: "", user: "" };
}
