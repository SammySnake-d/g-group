/** biome-ignore-all lint/correctness/noUnusedFunctionParameters: 红提交空壳,签名先行 */
// 普通数据对象判定(与 PR #3 统一的输入契约):"普通数据对象"即 JSON 可产生的形状。
// 判定顺序:先 types.isProxy → 原型 Object.prototype / null(数组为 Array.prototype)→ 逐层用属性描述符检查,
// 所有自有属性(含数组元素)必须是数据属性;出现 getter/setter 直接拒绝,永不调用。
// 只接受:字符串、有限数字、布尔、null、普通数组(不稀疏、只有下标与 length)、普通对象(可枚举的字符串键)。
// 对象属性值为 undefined 时按 JSON.stringify 的规则当作不存在;数组元素不能是 undefined。
// 中间表与结果都不经过原型链:描述符表放在空原型对象里,结果数组用 defineProperty 追加,
// 原型上的同名 setter、只读下标或可写值都不会被调用、挡住或借来补洞。
// 内核所有对外入口(插件注册、发送请求与回执、拉取结果、上下文装配、入站分类)都用这一个函数。
// 内核插件契约只接受普通数据对象,不承诺防御任意 JS 元编程对象:遇到就拒绝并点名路径。

export type PlainResult = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly path: string; readonly why: string };
export type PlainItems = { readonly ok: true; readonly items: readonly unknown[] } | { readonly ok: false; readonly path: string; readonly why: string };
export interface PlainOptions {
  /** 顶层对象的直接字段可以是函数(插件的 send/pull、装配的 recompress);函数原样保留引用 */
  readonly topFunctions?: boolean;
}

export function plainData(x: unknown, at = "输入", opts: PlainOptions = {}): PlainResult {
  throw new Error("未实现");
}

export function plainItems(x: unknown, at = "输入"): PlainItems {
  throw new Error("未实现");
}

export function safeDescribe(x: unknown): string {
  throw new Error("未实现");
}

export function describeThrown(err: unknown): string {
  throw new Error("未实现");
}
