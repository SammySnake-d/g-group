// U58 / D11：只读摘要插件，宿主只提供当前会话的快照。
export default {
  kind: "ui-extension",
  command() { return { text: "(空壳)" }; },
};
