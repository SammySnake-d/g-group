// SPDX-License-Identifier: Apache-2.0
// Adapted from milind-soni/OpenMausBot (613ed01fd).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { afterEach, beforeEach, describe, mock, test } from "node:test";
import { ArtifactStore } from "./artifacts.ts";
import { renameWithRetry, writeFileAtomic, writeFileAtomicIfChanged } from "./atomic.ts";
import { openDb } from "./db.ts";

const realSync = fs.fsyncSync;
const syncs = mock.method(fs, "fsyncSync");
const reads = mock.method(fs, "readFileSync");
syncBuiltinESMExports();
const contents = (p: string) => existsSync(p) ? readFileSync(p, "utf8") : undefined;

describe("writeFileAtomic", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "omb-atomic-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("writes the file", () => {
    const p = join(dir, "x.json");
    assert.doesNotThrow(() => writeFileAtomic(p, '{"a":1}'));
    assert.equal(contents(p), '{"a":1}');
  });

  test("replaces existing contents in full", () => {
    const p = join(dir, "x.json");
    writeFileAtomic(p, "old-and-longer");
    assert.doesNotThrow(() => writeFileAtomic(p, "new"));
    assert.equal(contents(p), "new");
  });

  test("leaves no temp files behind", () => {
    const p = join(dir, "x.json");
    writeFileAtomic(p, "a");
    assert.doesNotThrow(() => writeFileAtomic(p, "b"));
    assert.deepEqual(readdirSync(dir), ["x.json"]);
  });

  test("preserves unicode across the write", () => {
    const p = join(dir, "u.json");
    const s = JSON.stringify({ msg: "café — 日本語 — 🚀" });
    assert.doesNotThrow(() => writeFileAtomic(p, s));
    assert.equal(contents(p), s);
    assert.equal(existsSync(p), true);
  });

  test("applies the requested mode when replacing a file", () => {
    const p = join(dir, "secret.json");
    writeFileAtomic(p, "old");
    assert.equal(contents(p), "old");
    chmodSync(p, 0o644);

    assert.doesNotThrow(() => writeFileAtomic(p, "new", { mode: 0o600 }));

    assert.equal(statSync(p).mode & 0o777, 0o600);
  });

  test("cleans up the temporary file when replacement fails", () => {
    const p = join(dir, "target");
    mkdirSync(p);
    assert.throws(() => writeFileAtomic(p, "cannot replace a directory"), /EISDIR|ENOTDIR|EEXIST|ENOTEMPTY|EPERM/);
    assert.deepEqual(readdirSync(dir), ["target"]);
  });
});

// fsync is F_FULLFSYNC on macOS (~4 ms of blocked event loop), and several per-turn saves rewrite identical bytes.
describe("writeFileAtomic durability", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "omb-atomic-"));
    syncs.mock.resetCalls();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("fsyncs by default", () => {
    assert.doesNotThrow(() => writeFileAtomic(join(dir, "x.json"), "a"));
    assert.equal(syncs.mock.callCount(), 1);
  });

  test("still replaces atomically without the fsync when durable is false", () => {
    const p = join(dir, "x.json");
    writeFileAtomic(p, "old");
    syncs.mock.resetCalls();
    assert.doesNotThrow(() => writeFileAtomic(p, "new", { durable: false }));
    assert.equal(syncs.mock.callCount(), 0);
    assert.equal(contents(p), "new");
    assert.deepEqual(readdirSync(dir), ["x.json"]);
  });
});

describe("writeFileAtomicIfChanged", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "omb-atomic-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const clearSpies = () => {
    syncs.mock.resetCalls();
    reads.mock.resetCalls();
  };

  test("leaves the file alone when it already holds exactly these bytes", () => {
    const p = join(dir, "x.json");
    const data = JSON.stringify({ msg: "café — 日本語" });
    writeFileAtomic(p, data, { mode: 0o600 });
    assert.equal(contents(p), data);
    const before = statSync(p);
    clearSpies();

    assert.equal(writeFileAtomicIfChanged(p, data, { mode: 0o600 }), false);

    assert.equal(contents(p), data);
    const after = statSync(p);
    assert.equal(after.ino, before.ino);
    assert.equal(after.mtimeMs, before.mtimeMs);
    assert.equal(syncs.mock.callCount(), 0);
    assert.deepEqual(readdirSync(dir), ["x.json"]);
  });

  test("writes and fsyncs when the bytes differ", () => {
    const p = join(dir, "x.json");
    writeFileAtomic(p, '{"unread":true}');
    clearSpies();
    // Same length, different bytes: only the read can tell.
    assert.equal(writeFileAtomicIfChanged(p, '{"unread":fals}'), true);
    assert.equal(contents(p), '{"unread":fals}');
    assert.equal(syncs.mock.callCount(), 1);
  });

  test("does not read the old contents when the size already differs", () => {
    const p = join(dir, "x.json");
    writeFileAtomic(p, "short");
    clearSpies();
    assert.equal(writeFileAtomicIfChanged(p, "a longer replacement"), true);
    assert.equal(reads.mock.callCount(), 0);
    assert.equal(contents(p), "a longer replacement");
  });

  test("writes a file that does not exist yet", () => {
    const p = join(dir, "new.json");
    assert.equal(writeFileAtomicIfChanged(p, "fresh", { mode: 0o600 }), true);
    assert.equal(contents(p), "fresh");
  });

  test("passes durable through to the write", () => {
    const p = join(dir, "x.json");
    clearSpies();
    assert.doesNotThrow(() => writeFileAtomicIfChanged(p, "token", { durable: false }));
    assert.equal(syncs.mock.callCount(), 0);
    assert.equal(contents(p), "token");
  });

  test("rewrites identical bytes whose permissions are broader than requested", () => {
    const p = join(dir, "secret.json");
    writeFileAtomic(p, "same");
    assert.equal(contents(p), "same");
    chmodSync(p, 0o644);
    assert.equal(writeFileAtomicIfChanged(p, "same", { mode: 0o600 }), true);
    assert.equal(statSync(p).mode & 0o777, 0o600);
  });

  test("replaces a symlink holding identical bytes instead of following it", () => {
    const target = join(dir, "elsewhere.json");
    const p = join(dir, "x.json");
    writeFileSync(target, "same");
    symlinkSync(target, p);
    assert.equal(writeFileAtomicIfChanged(p, "same"), true);
    assert.equal(lstatSync(p).isSymbolicLink(), false);
    assert.equal(contents(p), "same");
    assert.equal(readFileSync(target, "utf8"), "same");
  });

  test("does not hang on a FIFO planted at the path", () => {
    const p = join(dir, "x.json");
    execFileSync("mkfifo", [p]);
    assert.equal(writeFileAtomicIfChanged(p, "data"), true);
    assert.equal(lstatSync(p).isFile(), true);
    assert.equal(contents(p), "data");
  });

  test("still fails like writeFileAtomic when the path cannot be replaced", () => {
    const p = join(dir, "target");
    mkdirSync(p);
    assert.throws(() => writeFileAtomicIfChanged(p, "cannot replace a directory"), /EISDIR|ENOTDIR|EEXIST|ENOTEMPTY|EPERM/);
    assert.deepEqual(readdirSync(dir), ["target"]);
  });
});

// Windows refuses a rename onto a path while a virus scanner or the indexer holds a handle for a few milliseconds.
describe("renameWithRetry", () => {
  function failing(times: number, code: string) {
    let calls = 0;
    return {
      get calls() {
        return calls;
      },
      rename: () => {
        calls += 1;
        if (calls <= times) throw Object.assign(new Error(`${code}: simulated`), { code });
      },
    };
  }

  test("survives a transient EPERM instead of losing the write", () => {
    const stub = failing(3, "EPERM");
    assert.doesNotThrow(() => renameWithRetry("a.tmp", "a", stub.rename));
    assert.equal(stub.calls, 4);
  });

  test("retries EACCES and EBUSY the same way", () => {
    for (const code of ["EACCES", "EBUSY"]) {
      const stub = failing(1, code);
      assert.doesNotThrow(() => renameWithRetry("a.tmp", "a", stub.rename));
      assert.equal(stub.calls, 2);
    }
  });

  test("gives up rather than retrying forever", () => {
    const stub = failing(Number.MAX_SAFE_INTEGER, "EPERM");
    assert.throws(() => renameWithRetry("a.tmp", "a", stub.rename), /EPERM/);
    assert.equal(stub.calls, 6); // first attempt plus five backoffs
  });

  test("does not retry an error that will never clear", () => {
    // Busy-waiting on a missing directory or a cross-device rename would hide
    // a real bug behind a delay and still fail.
    for (const code of ["ENOENT", "EXDEV", "EISDIR"]) {
      const stub = failing(Number.MAX_SAFE_INTEGER, code);
      assert.throws(() => renameWithRetry("a.tmp", "a", stub.rename), new RegExp(code));
      assert.equal(stub.calls, 1);
    }
  });
});


test("ArtifactStore durably syncs content before publishing and reuses a snapshotted file", () => {
  const dir = mkdtempSync(join(tmpdir(), "gg-artifact-atomic-"));
  const db = openDb(join(dir, "catalog.db"));
  const files = join(dir, "artifacts");
  const events: string[] = [];
  const sync = syncs.mock;
  const realRename = fs.renameSync;
  sync.mockImplementation((fd) => { events.push("fsync"); return realSync(fd); });
  const rename = mock.method(fs, "renameSync", (from: Parameters<typeof fs.renameSync>[0], to: Parameters<typeof fs.renameSync>[1]) => { events.push("rename"); return realRename(from, to); });
  syncBuiltinESMExports();
  try {
    const store = new ArtifactStore(db, files, () => "2026-11-18T00:00:00.000Z");
    const data = Buffer.from("完整快照\n");
    const entry = store.put("test.md", data);
    assert.deepEqual(events, ["fsync", "rename"]);
    assert.deepEqual(store.read(entry.ref)?.data, data);
    assert.deepEqual(readdirSync(files), [`${entry.sha256}.md`]);
    assert.equal(store.put("test.md", data).ref, entry.ref);
    assert.deepEqual(events, ["fsync", "rename"], "dedup does not rewrite the file");
  } finally {
    sync.restore();
    rename.mock.restore();
    syncBuiltinESMExports();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
