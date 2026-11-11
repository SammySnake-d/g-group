// Helper 专属 MCP 的 stdio 传输(D07.0:同一个 MCP 服务也能以 stdio 方式启动供外部用;cli.ts mcp 子命令)。
// 一行一个 JSON-RPC 消息(与 adapter-cc-compute/mcp/report-mcp.mjs 相同的写法):不是 JSON 回 -32700,带 id:null,继续处理后续行;
// 通知不回。输入结束时等在途请求处理完再返回。
import readline from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { McpServer } from "@g-group/kernel";

export async function serveMcpStdio(server: McpServer, input: Readable, output: Writable): Promise<void> {
  const send = (o: unknown) => output.write(`${JSON.stringify(o)}\n`);
  const rl = readline.createInterface({ input });
  const pending = new Set<Promise<void>>();
  for await (const line of rl) {
    if (!line.trim()) continue;
    let m: unknown;
    try {
      m = JSON.parse(line);
    } catch {
      send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
      continue;
    }
    const p = server.handle(m).then((res) => {
      if (res) send(res);
    });
    pending.add(p);
    void p.finally(() => pending.delete(p));
    // 按行顺序处理:一条做完再读下一条,工具调用不并发
    await p;
  }
  await Promise.allSettled([...pending]);
}
