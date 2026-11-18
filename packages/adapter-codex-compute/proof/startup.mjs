// Resource admission, including overload and timeout removal, without starting a model.
import assert from "node:assert/strict";
import { startupSlot } from "../src/startup.ts";
const first = await startupSlot(1000), second = await startupSlot(1000);
let admitted = 0;
const queued = Array.from({ length: 32 }, () => startupSlot(1000).then(release => { admitted++; release(); }));
await assert.rejects(startupSlot(1000), /queue full/);
assert.equal(admitted, 0, "only two concurrent startups may hold a slot");
first(); second();
await Promise.all(queued);
assert.equal(admitted, 32);
const a = await startupSlot(1000), b = await startupSlot(1000);
await assert.rejects(startupSlot(20), /slot timeout/);
a(); b();
const last = await startupSlot(1000); last();
console.log("startup admission: concurrency 2, queue 32, overload rejection, timeout removal and recovery passed");
