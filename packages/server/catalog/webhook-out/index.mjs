// Webhook 外发(示例输出渠道插件)。宿主在隔离子进程里运行它:只能读本包目录,不能写文件、起子进程;
// 网络未被宿主隔离,靠清单权限 net:post 告知用户。
// B2 渠道(idempotency none):接收端不按 action_id 去重,结果未知时宿主不自动重发。
// 发送只按宿主在请求里给的 endpoint(首次投递时绑定的接收端),不读插件自己的可变状态。
let url = null;

export default {
  kind: "outbound-channel",
  init(config) {
    url = typeof config?.url === "string" && /^https?:\/\//.test(config.url) ? config.url : null;
  },
  describe() {
    return { idempotency: "none", endpoint: url ? `webhook:${url}` : null };
  },
  async send(req) {
    const target = typeof req?.endpoint === "string" && req.endpoint.startsWith("webhook:") ? req.endpoint.slice("webhook:".length) : null;
    if (!target) throw new Error("接收端不是 webhook 地址");
    const res = await fetch(target, {
      method: "POST",
      headers: { "content-type": "application/json", "x-g-group-action-id": req.action_id },
      body: JSON.stringify({ action_id: req.action_id, text: req.payload }),
    });
    if (!res.ok) throw new Error(`Webhook 返回 HTTP ${res.status}`);
    await res.arrayBuffer().catch(() => {});
    return { action_id: req.action_id, receiptId: res.headers.get("x-receipt-id") || `http-${res.status}-${req.action_id}` };
  },
};
