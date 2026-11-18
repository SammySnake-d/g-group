// Native MCP progress channel; app-server exposes the structured result in item/completed.
import { createInterface } from "node:readline";
const tool = { name: "report_progress", description: "Report a milestone or blocker to the task owner.", inputSchema: { type: "object", properties: { kind: { enum: ["milestone", "blocked"] }, summary: { type: "string" }, stage: { type: "string" }, needs: { type: "string" } }, required: ["kind", "summary"], additionalProperties: false } };
for await (const line of createInterface({ input: process.stdin })) {
  let m; try { m = JSON.parse(line); } catch { continue; }
  if (m.id === undefined) continue;
  let result;
  if (m.method === "initialize") result = { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "gg_progress", version: "1.0.0" } };
  else if (m.method === "tools/list") result = { tools: [tool] };
  else if (m.method === "tools/call") {
    const a = m.params.arguments;
    const valid = m.params.name === "report_progress" && a && typeof a.summary === "string" && a.summary.trim() && (a.kind === "milestone" ? typeof a.stage === "string" : a.kind === "blocked" && typeof a.needs === "string");
    result = valid ? { content: [{ type: "text", text: "reported" }], structuredContent: a } : { isError: true, content: [{ type: "text", text: "invalid report" }] };
  }
  if (result) process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }) + "\n");
  else process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "unsupported method" } }) + "\n");
}
