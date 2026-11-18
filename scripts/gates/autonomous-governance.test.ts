import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { runContractChecks } from "../check-contracts.ts";
import { runDocChecks } from "../check-docs.ts";
import { runStructureChecks } from "../check-structure.ts";

function fixture(t: TestContext, files: Record<string, string>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "g0-governance-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (rel: string, content: string) => {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  };
  for (const [rel, content] of Object.entries(files)) write(rel, content);
  return { root, write };
}

const specIds = ["AC-01", "V-01", "R-01"];
const docFiles = {
  "CLAUDE.md": "@AGENTS.md\n@LESSONS.md\n",
  "AGENTS.md": "See [standards](docs/code-standards.md).\n~~~md\n[example](does-not-exist.md)\n~~~\n",
  "LESSONS.md": "# Lessons\n",
  "docs/code-standards.md": "# Standards\n",
  "docs/BACKEND-PROGRESS-CHECKLIST.md": "# Progress\n",
  "docs/RECEIPT.md": "# Receipt\n",
  "docs/subsystems/README.md": "# Index\n",
  "docs/subsystems/example.md": "Owns `packages/example` and `scripts/`.\n",
  "docs/spec/验收文档-v0.1.md": specIds.join("\n"),
  "scripts/contract-baseline.json": JSON.stringify({ methods: ["rooms.get"], events: ["room.updated"], exports: ["METHODS", "ServerEvent"], specIds }),
  "packages/example/package.json": "{}",
};

test("documentation rejects long agent guides, broken links, missing ownership and deleted spec IDs", (t) => {
  const { root, write } = fixture(t, docFiles);
  write("AGENTS.md", "instruction\n".repeat(140) + "[missing](nowhere.md)\n");
  write("docs/subsystems/example.md", "Owns packages/example-other.");
  write("docs/spec/验收文档-v0.1.md", "AC-01\nR-01\n");
  const invalid = runDocChecks(root);
  assert.equal(invalid.ok, false);
  for (const expected of [/140/, /nowhere\.md/, /packages\/example\b/, /V-01/]) {
    assert.match(invalid.issues.join("\n"), expected);
  }
  for (const [rel, content] of Object.entries(docFiles)) write(rel, content);
  assert.deepEqual(runDocChecks(root), { ok: true, issues: [] });
});

const api = "packages/api-contract/src/";
const rpc = 'export const METHODS = { "rooms.get": {}, "rooms.added": {} };';
const events = 'export const ServerEvent = unionBy("type", { "room.updated": {}, "room.added": {} });';
const contractFiles = {
  "scripts/contract-baseline.json": docFiles["scripts/contract-baseline.json"],
  [api + "api.ts"]: rpc,
  [api + "events.ts"]: events,
  [api + "index.ts"]: 'export * from "./api.ts"; export * from "./events.ts";',
};

test("contract checks protect baseline keys and permit backend additions ahead of frontend", (t) => {
  const { root, write } = fixture(t, contractFiles);
  const frontendDir = path.join(root, "frontend");
  write("frontend/api.ts", 'export const METHODS = { "rooms.get": {} };');
  write("frontend/events.ts", 'export const ServerEvent = unionBy("type", { "room.updated": {} });');
  write(api + "api.ts", 'export const METHODS = { "rooms.added": {} };');
  write(api + "events.ts", 'export const ServerEvent = unionBy("type", { "room.added": {} });');
  write(api + "index.ts", 'export * from "./events.ts";');
  const invalid = runContractChecks(root, { frontendDir, updateBaseline: true });
  assert.equal(invalid.ok, false);
  for (const expected of [/baseline.*rooms\.get/i, /baseline.*room\.updated/i, /baseline.*METHODS/i, /frontend.*rooms\.get/i, /frontend.*room\.updated/i]) {
    assert.match(invalid.issues.join("\n"), expected);
  }
  write(api + "api.ts", rpc);
  write(api + "events.ts", events);
  write(api + "index.ts", contractFiles[api + "index.ts"]!);
  assert.equal(runContractChecks(root, { frontendDir }).ok, true);
  assert.equal(runContractChecks(root, { frontendDir, updateBaseline: true }).ok, true);
  write(api + "api.ts", 'export const METHODS = { "rooms.get": {} };');
  assert.match(runContractChecks(root, { frontendDir }).issues.join("\n"), /baseline.*rooms\.added/i);
});

test("structure rejects I/O, skipped tests and new or growing oversized sources", (t) => {
  const { root, write } = fixture(t, { "scripts/structure-baseline.json": JSON.stringify({ oversizedFiles: { "scripts/legacy.ts": 451 } }) });
  write("packages/domain/src/example.ts", 'import fs from "node:fs/promises";');
  write("packages/kernel/src/example.ts", 'export { readFile } from "node:fs";');
  write("packages/domain/src/skipped.test.mjs", "");
  write("packages/kernel/src/skipped.test.cjs", "");
  write("packages/example/src/skipped.spec.ts", "");
  write("packages/example/src/large.ts", "// line\n".repeat(451));
  write("scripts/legacy.ts", "// line\n".repeat(452));
  const invalid = runStructureChecks(root, { updateBaseline: true });
  assert.equal(invalid.ok, false);
  for (const expected of [/domain\/src\/example\.ts.*node:fs/, /kernel\/src\/example\.ts.*node:fs/, /skipped\.test\.mjs/, /skipped\.test\.cjs/, /skipped\.spec\.ts/, /large\.ts.*450/, /legacy\.ts.*451/]) {
    assert.match(invalid.issues.join("\n"), expected);
  }
  write("packages/domain/src/example.ts", "// import from 'node:fs' is banned");
  write("packages/kernel/src/example.ts", "export const state = 1;");
  for (const rel of ["packages/domain/src/skipped.test.mjs", "packages/kernel/src/skipped.test.cjs", "packages/example/src/skipped.spec.ts"]) {
    fs.unlinkSync(path.join(root, rel));
  }
  write("packages/domain/src/fixture.test.ts", 'import fs from "node:fs";\n' + "// line\n".repeat(451));
  write("packages/example/src/large.ts", "// line\n".repeat(450));
  write("scripts/legacy.ts", "// line\n".repeat(451));
  assert.deepEqual(runStructureChecks(root), { ok: true, issues: [] });
});
