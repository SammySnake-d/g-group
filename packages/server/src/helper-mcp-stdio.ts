// Helper 专属 MCP 的 stdio 传输。空壳:待实现。
import type { Readable, Writable } from "node:stream";
import type { McpServer } from "@g-group/kernel";

export async function serveMcpStdio(_server: McpServer, _input: Readable, _output: Writable): Promise<void> {}
