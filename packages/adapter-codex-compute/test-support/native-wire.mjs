import { createInterface } from "node:readline";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
let initialized = false;
let n = 0;
const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
const mode = process.env.FIXTURE_MODE ?? "normal";
const thread = "native-thread-1";
const stored = path.join(process.env.CODEX_HOME, "fixture-history.json");
const terminal = (id, status = "completed") => ({ method: "turn/completed", params: { threadId: thread, turn: { id, status, items: [{ type: "agentMessage", id: `item-${id}`, text: `reply-${id}` }], error: null } } });
createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  appendFileSync(path.join(process.env.CODEX_HOME, "wire-requests.jsonl"), JSON.stringify(m) + "\n");
  if (m.method === "initialize") send({ id: m.id, result: { codexHome: process.env.CODEX_HOME } });
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
    send({ id: m.id, result: { turn: { id, status: "inProgress", items: [] } } });
    send({ method: "turn/started", params: { threadId: thread, turn: { id, status: "inProgress" } } });
    if (mode === "exit0") process.exit(0);
    if (mode !== "hold") send(terminal(id));
  } else if (m.method === "turn/steer") send(m.params.expectedTurnId === `native-turn-${n}` ? { id: m.id, result: { turnId: `native-turn-${n}` } } : { id: m.id, error: { code: -32600, message: "expected active turn id mismatch" } });
  else if (m.method === "turn/interrupt") { send({ id: m.id, result: {} }); send(terminal(m.params.turnId, "interrupted")); }
});
