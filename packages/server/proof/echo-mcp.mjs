// 中性的 stdio MCP 服务器(真实运行证据用):只有一个 echo 工具,返回 ECHO:<text>。不读写任何文件。
import readline from "node:readline";
const out = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
readline.createInterface({ input: process.stdin }).on("line", (l) => {
  let m; try { m = JSON.parse(l); } catch { return; }
  if (m.method === "initialize") out({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "gg-echo", version: "0.0.1" } } });
  else if (m.method === "tools/list") out({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "echo", description: "原样回显 text,前面加 ECHO:", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }] } });
  else if (m.method === "tools/call") out({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: `ECHO:${m.params?.arguments?.text ?? ""}` }] } });
  else if (m.id !== undefined) out({ jsonrpc: "2.0", id: m.id, result: {} });
});
