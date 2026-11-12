// Q08/AC-23: narrowly permit adapter -> process without relaxing other directions.
import assert from "node:assert/strict";
import { test } from "node:test";
import { layers } from "./gates.ts";
import type { Ctx } from "./lib.ts";

function context(files: Record<string, string>): Ctx {
  return { root: "/fixture", branch: "fixture", files: Object.keys(files), changed: Object.keys(files),
    read: (p) => files[p], readBase: () => undefined, receipt: undefined, receiptPath: "", specIds: new Set(),
    runTests: () => { throw new Error("G-LAYER must not run payload code"); }, contentHash: () => "fixture",
    snapshot: () => undefined, pr: undefined };
}
const manifest = (name: string, layer: string, dependencies: Record<string, string> = {}) => JSON.stringify({ name, gGroup: { layer }, dependencies });
const processFiles = { "packages/process-tools/package.json": manifest("@g-group/process-tools", "process"), "packages/process-tools/src/index.ts": "export const cleanup = 1;" };

test("S-PROC-LAYER-01: adapter may import and declare the new process utility", () => {
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
