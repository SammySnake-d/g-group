// Standalone B4 live verification. Never invoked by npm test or CI.
// From the workspace root: node packages/server/proof/magpie-live-probe.mjs
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstatSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { discoverMagpieGateway, probeModelConnection } from "@g-group/adapter-pi-contact";
import { sendAndWait } from "../src/drive.ts";
import { startServer } from "../src/start.ts";

const ENDPOINT = "http://127.0.0.1:3425";
const MODEL = "ling-jing/deepseek-v4.1-flash";
const scope = path.join(homedir(), ".config", "magpie");
const configFiles = ["gateway.json", "settings.json", "providers.json", "logins.json"];
const env = { MAGPIE_BASE_URL: ENDPOINT, ...(process.env.MAGPIE_TOKEN ? { MAGPIE_TOKEN: process.env.MAGPIE_TOKEN } : {}) };
const knownPaths = new Set(["/api/hello", "/v1/models", "/v1/chat/completions", "/v1/messages", "/v1/responses"]);
const actualFetch = globalThis.fetch.bind(globalThis);
let phase = "configuration fingerprint";
let started;
let before;
let dataDir;
const wire = [];
const runtimeReports = new Set(["round-failed", "reflect-failed", "compact-failed"]);
const errorKind = (message) => {
  if (/max_output_tokens|output.length|truncat|输出上限/i.test(message)) return "output-length";
  if (/timeout|abort/i.test(message)) return "timeout-or-abort";
  if (/connection_check/.test(message)) return "missing-or-invalid-tool-call";
  if (/rate.limit|\b429\b|quota/i.test(message)) return "rate-limit-or-quota";
  if (/\b(401|403)\b|unauthorized/i.test(message)) return "upstream-auth";
  if (/\b(500|502|503|504)\b|server_error|overloaded|upstream/i.test(message)) return "upstream-error";
  if (/premature|unexpected end|terminated|ECONNRESET|connection closed/i.test(message)) return "stream-ended-early";
  return "other-provider-error";
};

// The running daemon updates telemetry and quota state, not part of this config check.
// Compare regular-file contents and metadata internally; never print paths or digests.
function fingerprint() {
  return configFiles.map((name) => {
    const file = path.join(scope, name);
    const st = lstatSync(file, { bigint: true });
    assert.ok(st.isFile());
    return { mtimeNs: st.mtimeNs, size: st.size, digest: createHash("sha256").update(readFileSync(file)).digest("hex") };
  });
}

let primary;
let injected = false;
async function fetch(resource, init) {
  const request = new Request(resource, init);
  const u = new URL(request.url);
  assert.equal(u.origin, ENDPOINT);
  assert.ok(knownPaths.has(u.pathname));
  const event = { path: u.pathname, method: request.method, phase };
  wire.push(event);
  if (event.method === "POST") {
    const b = await request.clone().json();
    assert.equal(b.model, MODEL);
    assert.equal(b.stream, true);
    event.tools = Array.isArray(b.tools) ? b.tools.length : 0;
    event.max = b.max_output_tokens ?? b.max_completion_tokens ?? b.max_tokens;
    if (phase === "conversation 1" && u.pathname === primary && !injected) {
      injected = true;
      event.status = 400;
      event.injected = true;
      return Response.json({ error: { message: "B4 controlled primary codec refusal before SSE" } }, { status: 400 });
    }
  }
  try {
    const response = await actualFetch(request, { redirect: "error" });
    event.status = response.status;
    return response;
  } catch {
    event.status = "unreachable";
    throw new Error("Local gateway transport failed");
  }
}

console.log(`B4 local Magpie verification: ${new Date().toISOString()} ${ENDPOINT} ${MODEL}`);
try {
  before = fingerprint();
  dataDir = mkdtempSync(path.join(tmpdir(), "gg-b4-magpie-"));
  phase = "discovery";
  const gateway = await discoverMagpieGateway({ env, fetch });
  const model = gateway.models.find((m) => m.id === MODEL);
  assert.ok(model?.reasoning && model.nativeEndpoints?.length && model.protocols.includes("openai-responses"));
  assert.deepEqual(wire.slice(0, 2).map((e) => [e.path, e.method, e.status]), [["/api/hello", "GET", 200], ["/v1/models", "GET", 200]]);
  console.log(`PASS discovery: hello identified Magpie; exact model advertised ${model.protocols.join(", ")}`);

  phase = "one-tool probe";
  const probe = await probeModelConnection({ provider: "magpie", baseUrl: gateway.baseUrl, apiKey: gateway.apiKey, model: MODEL,
    api: "openai-responses", reasoning: model.reasoning, healthCache: gateway.healthCache, maxTokens: 64, fetch }, AbortSignal.timeout(120_000));
  const probeWire = wire.filter((t) => t.phase === phase);
  if (!probe.ok) console.log(`diagnostic one-tool probe: ${errorKind(probe.error)}`);
  assert.ok(probe.ok && probe.protocol === "openai-responses" && probe.model === MODEL);
  assert.ok(probeWire.length === 1 && probeWire[0].tools === 1 && probeWire[0].max >= 8192 && probeWire[0].status === 200);
  console.log(`PASS one-tool probe: decoded connection_check(ok=true); /v1/responses HTTP 200, max_output_tokens=${probeWire[0].max}, provider usage=${probe.usage ? "present" : "not reported"}`);

  phase = "server startup";
  const first = model.protocols.find((p) => p === "openai-chat" || p === "anthropic-messages");
  assert.ok(first, "proof requires two advertised codecs");
  primary = first === "openai-chat" ? "/v1/chat/completions" : "/v1/messages";
  started = await startServer({ mind: "pi", compute: "fake", dataDir, env, model: MODEL, protocols: [first, "openai-responses"], fetch,
    onReport(what) { if (runtimeReports.has(what)) console.log(`runtime ${phase}: ${what}`); } });
  const c = started.host.createContact({ name: "B4 live", persona: "For each new mention, immediately send its requested marker with the reply tool. No other tools or tasks." });
  const room = started.host.createGroup("B4 local proof", [{ kind: "contact", id: c.id }]);
  for (const i of [1, 2]) {
    phase = `conversation ${i}`;
    const marker = i === 1 ? "B4-ORBIT" : "B4-HARBOR";
    const r = await sendAndWait(started.host, room.id, `Call reply now in the current room with text exactly ${marker}. Then finish.`,
      { mention: c.name, timeoutMs: 240_000, settleMs: 100 });
    const contactReplies = r.transcript.filter((m) => m.seq > r.sent.seq && m.sender.kind === "contact" && m.sender.id === c.id);
    const replies = contactReplies.filter((m) => m.text.includes(marker));
    if (r.timedOut || replies.length === 0) console.log(`diagnostic round ${i}: timedOut=${r.timedOut}, contactReplies=${contactReplies.length}, matchingReplies=${replies.length}`);
    assert.ok(!r.timedOut && replies.length > 0);
    const posts = wire.filter((e) => e.phase === phase && e.method === "POST");
    assert.ok(posts.some((e) => e.status === 200 && e.tools > 0) && posts.some((e) => e.status === 200 && e.tools === 0));
    assert.ok(posts.every((e) => e.max >= 8192));
    console.log(`PASS round ${i}: committed contact reply observed in the transcript; matching replies=${replies.length}, min output token budget=${Math.min(...posts.map((e) => e.max))} (round and reflection)`);
  }
  phase = "pre-commit failover";
  const calls = wire.filter((e) => e.method === "POST" && e.phase.startsWith("conversation"));
  assert.deepEqual(calls.slice(0, 2).map((e) => [e.path, e.status, e.injected === true]), [[primary, 400, true], ["/v1/responses", 200, false]]);
  console.log(`PASS pre-commit failover: ${primary} controlled HTTP 400 before SSE → live /v1/responses HTTP 200 on the same model`);

  phase = "SQLite and usage.cacheStats";
  const lines = started.host.usage.rows();
  const rawCount = started.host.db.store.db.prepare("SELECT count(*) AS total FROM gg_usage").get().total;
  assert.equal(rawCount, lines.length);
  assert.ok(lines.length >= 4 && new Set(lines.filter((r) => r.kind === "round").map((r) => r.roundId)).size === 2);
  assert.ok(lines.every((r) => r.explicitBreakpoints === false && r.breakpoints === 0 && r.line.endsWith(`|${MODEL}`)));
  const stats = await started.service.handle("usage.cacheStats", { by: ["line", "kind"] });
  assert.ok(stats.ok && stats.value.groups.reduce((sum, g) => sum + g.calls, 0) === rawCount);
  const cacheRead = lines.reduce((sum, r) => sum + r.cacheRead, 0);
  assert.ok(cacheRead > 0 && stats.value.groups.reduce((sum, g) => sum + g.cacheRead, 0) === cacheRead);
  for (const g of stats.value.groups) {
    console.log(`PASS usage.cacheStats ${g.kind}: calls=${g.calls} counted=${g.countedCalls} input=${g.input} cacheRead=${g.cacheRead} cacheWrite=${g.cacheWrite} output=${g.output} hitRate=${g.hitRate}`);
  }
  console.log(`PASS gg_usage: ${rawCount} persisted provider usage rows, cacheRead=${cacheRead}, explicitBreakpoints=false, breakpoints=0`);
} catch {
  console.log(`FAIL ${phase} (raw gateway, model and account messages intentionally omitted)`);
  process.exitCode = 1;
} finally {
  try {
    await started?.close();
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    if (before) {
      const after = fingerprint();
      const changed = after.filter((entry, i) => entry.mtimeNs !== before[i].mtimeNs || entry.size !== before[i].size || entry.digest !== before[i].digest).length;
      if (changed) console.log(`diagnostic config fingerprint: ${changed} of ${after.length} allowlisted files differed`);
      assert.deepEqual(after, before);
      console.log(`PASS config read-only: ${after.length} allowlisted config files unchanged (SHA-256, mtime and size; daemon telemetry excluded)`);
    }
  } catch {
    console.log("FAIL read-only fingerprint comparison or temporary data cleanup; no raw paths or config values printed");
    process.exitCode = 1;
  }
  for (const event of wire) console.log(`wire ${event.phase}: ${event.method} ${event.path} ${event.status ?? "no response"}${event.injected ? " (synthetic primary refusal)" : ""}${Number.isInteger(event.max) ? ` max_output=${event.max} tools=${event.tools}` : ""}`);
}
