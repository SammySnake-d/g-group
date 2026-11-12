import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
let initialized = false;
let n = 0;
const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
const mode = process.env.FIXTURE_MODE ?? "normal";
const thread = "native-thread-1";
const stored = path.join(process.env.CODEX_HOME, "fixture-history.json");
const terminal = (id, status = "completed") => ({ method: "turn/completed", params: { threadId: thread, turn: { id, status, items: [{ type: "agentMessage", id: `item-${id}`, text: `reply-${id}` }], error: null } } });
createInterface({ input: process.stdin }).on("line", async (line) => {
  const m = JSON.parse(line);
  appendFileSync(path.join(process.env.CODEX_HOME, "wire-requests.jsonl"), JSON.stringify(m) + "\n");
  if (m.id === "native-approval-1" && m.error) send({ method: "turn/completed", params: { threadId: thread, turn: { id: `native-turn-${n}`, status: "failed", items: [], error: { message: "unsupported native approval refused" } } } });
  else if (m.method === "initialize") {
    if (mode === "children") {
      const helper = spawn(process.execPath, [path.resolve(import.meta.dirname, "../../process-tools/test-support/three-children.mjs")], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
      const [chunk] = await once(helper.stdout, "data");
      const { pids } = JSON.parse(chunk.toString());
      writeFileSync(path.join(process.env.CODEX_HOME, "fixture-children.json"), JSON.stringify({ helper: helper.pid, pids }));
      helper.stdout.destroy(); helper.unref();
    }
    if (mode === "foreign-rpc") send({ id: "unrelated-rpc-id", result: { codexHome: "/definitely-not-owner" } });
    send({ id: m.id, result: { codexHome: process.env.CODEX_HOME } });
  }
  else if (m.method === "initialized") initialized = true;
  else if (m.method === "thread/start") {
    writeFileSync(stored, JSON.stringify({ id: thread, turns: [] }));
    send(initialized ? { id: m.id, result: { thread: { id: thread, ephemeral: false }, model: m.params.model } } : { id: m.id, error: { code: -32600, message: "initialized notification missing" } });
  } else if (m.method === "thread/resume") {
    const state = existsSync(stored) ? JSON.parse(readFileSync(stored, "utf8")) : null;
    send(state && m.params.threadId === thread ? { id: m.id, result: { thread: state, model: m.params.model } } : { id: m.id, error: { code: -32600, message: "no rollout found" } });
  } else if (m.method === "turn/start") {
    const id = `native-turn-${++n}`;
    const state = JSON.parse(readFileSync(stored, "utf8")); state.turns.push({ id }); writeFileSync(stored, JSON.stringify(state));
    if (mode === "early") {
      send({ method: "turn/completed", params: { threadId: "foreign-thread", turn: { id, status: "completed", items: [{ type: "agentMessage", text: "FOREIGN" }] } } });
      send(terminal("foreign-turn"));
      send({ method: "turn/started", params: { threadId: thread, turn: { id, status: "inProgress" } } });
      send(terminal(id));
    }
    send({ id: m.id, result: { turn: { id, status: "inProgress", items: [] } } });
    send({ method: "turn/started", params: { threadId: thread, turn: { id, status: "inProgress" } } });
    if (mode === "exit0") process.exit(0);
    if (mode === "approval") send({ id: "native-approval-1", method: "item/commandExecution/requestApproval", params: { threadId: thread, turnId: id, command: "fixture-not-executed" } });
    else if (!["hold", "ack-only"].includes(mode)) send(terminal(id));
  } else if (m.method === "turn/steer") send(m.params.expectedTurnId === `native-turn-${n}` ? { id: m.id, result: { turnId: `native-turn-${n}` } } : { id: m.id, error: { code: -32600, message: "expected active turn id mismatch" } });
  else if (m.method === "turn/interrupt") { send({ id: m.id, result: {} }); if (mode !== "ack-only") send(terminal(m.params.turnId, "interrupted")); }
});
