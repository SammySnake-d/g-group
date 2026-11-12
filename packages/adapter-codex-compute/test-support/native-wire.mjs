import { createInterface } from "node:readline";
let initialized = false;
const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.method === "initialize") send({ id: m.id, result: { codexHome: process.env.CODEX_HOME } });
  else if (m.method === "initialized") initialized = true;
  else if (m.method === "thread/start") send(initialized ? { id: m.id, result: { thread: { id: "native-thread-1", ephemeral: false }, model: m.params.model } } : { id: m.id, error: { code: -32600, message: "initialized notification missing" } });
});
