// f790496 的 index.html 已有该 CSP 配置；它在 meta 中无效，浏览器会明确报错。
// 这是现存壳层问题，不在组件试跑中修改安全策略。要求精确相同，不吞掉其他报错。
export const BASELINE_CONSOLE = ["The Content Security Policy directive 'frame-ancestors' is ignored when delivered via a <meta> element."];
