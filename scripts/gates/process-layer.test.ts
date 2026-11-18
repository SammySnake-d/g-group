// Q08/AC-23 prerequisite: adapters may use the process utility layer, while higher layers stay isolated.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { agyRecoverStepModels, layers } from "./gates.ts";
import type { Ctx } from "./lib.ts";

const { DatabaseSync: SqliteDb } = createRequire(import.meta.url)("node:sqlite") as { DatabaseSync: typeof DatabaseSync };

function context(files: Record<string, string>): Ctx {
  return { root: "/fixture", branch: "fixture", files: Object.keys(files), changed: Object.keys(files),
    read: (p) => files[p], readBase: () => undefined, receipt: undefined, receiptPath: "", specIds: new Set(),
    runTests: () => { throw new Error("G-LAYER must not run payload code"); }, contentHash: () => "fixture",
    snapshot: () => undefined, pr: undefined };
}
const manifest = (name: string, layer: string, dependencies: Record<string, string> = {}) => JSON.stringify({ name, gGroup: { layer }, dependencies });
const processFiles = { "packages/process-tools/package.json": manifest("@g-group/process-tools", "process"), "packages/process-tools/src/index.ts": "export const cleanup = 1;" };

test("S-PROC-LAYER-01: adapter may import and declare the process utility", () => {
  const result = layers.run(context({ ...processFiles,
    "packages/a/package.json": manifest("@g-group/a", "adapter", { "@g-group/process-tools": "*" }),
    "packages/a/src/index.ts": 'export { cleanup } from "@g-group/process-tools";' }));
  assert.deepEqual(result, []);
});

test("S-PROC-LAYER-02: adapter-to-adapter imports and declarations remain forbidden", () => {
  const result = layers.run(context({ ...processFiles,
    "packages/a/package.json": manifest("@g-group/a", "adapter", { "@g-group/b": "*" }),
    "packages/b/package.json": manifest("@g-group/b", "adapter"),
    "packages/a/src/index.ts": 'export { b } from "@g-group/b";' }));
  assert.equal(result.some((p) => p.msg.includes("不能依赖 adapter")), true);
  assert.equal(result.some((p) => p.msg.includes("依赖声明里引用了 adapter")), true);
});

test("S-PROC-LAYER-03: domain and kernel cannot acquire process I/O through imports or declarations", () => {
  const result = layers.run(context({ ...processFiles,
    "packages/d/package.json": manifest("@g-group/d", "domain", { "@g-group/process-tools": "*" }),
    "packages/k/package.json": manifest("@g-group/k", "kernel", { "@g-group/process-tools": "*" }),
    "packages/d/src/index.ts": 'import "@g-group/process-tools";',
    "packages/k/src/index.ts": 'import "@g-group/process-tools";' }));
  assert.equal(result.filter((p) => p.msg.includes("不能依赖 process")).length, 2);
  assert.equal(result.filter((p) => p.msg.includes("依赖声明里引用了 process")).length, 2);
});

test("S-PROC-LAYER-04: plugin/app do not gain the new process dependency and process cannot depend upward", () => {
  const result = layers.run(context({ ...processFiles,
    "packages/p/package.json": manifest("@g-group/p", "plugin"),
    "packages/app/package.json": manifest("@g-group/app", "app"),
    "packages/p/src/index.ts": 'import "@g-group/process-tools";',
    "packages/app/src/index.ts": 'import "@g-group/process-tools";',
    "packages/process-tools/src/index.ts": 'import "@g-group/p";' }));
  assert.equal(result.filter((p) => p.msg.includes("不能依赖 process")).length, 2);
  assert.equal(result.some((p) => p.msg.includes("不能依赖 plugin")), true);
});
test("S-PROC-LAYER-05: relative cross-package imports remain forbidden", () => {
  const result = layers.run(context({ ...processFiles,
    "packages/a/package.json": manifest("@g-group/a", "adapter"),
    "packages/a/src/index.ts": 'import "../../process-tools/src/index.ts";' }));
  assert.equal(result.some((p) => p.msg.includes("跨出了包")), true);
});

test("agyRecoverStepModels recognizes dotted Gemini versions and rejects malformed or unknown names", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-gemini-dotted-"));
  const conv = path.join(dir, "conversations");
  fs.mkdirSync(conv);
  const writer = new SqliteDb(path.join(conv, "models.db"));
  try {
    writer.exec("CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB);");
    const insert = writer.prepare("INSERT INTO gen_metadata (idx, data) VALUES (?, ?)");
    insert.run(1, Buffer.from("last_step_index:0 MODEL_PLACEHOLDER_M001 gemini-3.8-flash-s"));
    insert.run(2, Buffer.from("last_step_index:1 MODEL_PLACEHOLDER_M002 gemini-3.8-flash-high"));
    insert.run(3, Buffer.from("last_step_index:2 MODEL_PLACEHOLDER_M003 gemini-3.8-"));
    insert.run(4, Buffer.from("last_step_index:3 MODEL_PLACEHOLDER_M004 gemini-unknown-model"));
    assert.deepEqual(agyRecoverStepModels(conv, "models"), new Map([[1, "gemini-3.8-flash-s"], [2, "gemini-3.8-flash-high"]]));
  } finally {
    writer.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
