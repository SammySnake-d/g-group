// R11-TEST-01 夹具:模块在导出绑定初始化前抛错,留下一个"未初始化"的模块命名空间。
// 它原型为 null、不是 Proxy,但对其中的 let 导出取描述符会抛 ReferenceError,用来证明 normalizeEvent 外层兜底可达。
import * as ns from "./tdz-namespace.mjs";
globalThis.__r11TdzNamespace = ns;
throw new Error("stop");
export let kind = "Claim";
