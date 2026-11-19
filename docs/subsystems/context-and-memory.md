# Context and Memory

`packages/adapter-pi-contact` owns the contact request and recall wire path. The kernel owns round assembly, compaction, recall, and write planning. The server wires those pieces to durable storage and API views.

| Scope | Window | Admission and continuity |
| --- | --- | --- |
| Working, Contact | Five-block `CarryOn` | Block 1 admits global stable material and stays byte-identical across turns. No character or token cap (AC-42 ⑥, #2391). Blocks 2–5 carry changing round context. |
| Working, Compute | Isolated context for the Compute slot | Execution progress and transcript stay scoped to the slot and its harness. |

**Upcoming Slice C0 (`bg-compact`).** The Codex-style background compaction design uses dual cursors. A background job compacts against a captured watermark while new turns continue. Adoption must keep the recent delta through the compaction watermark lossless and preserve all turns after it. This is an acceptance boundary for C0. The [background compaction module](../../packages/server/src/bg-compaction.ts) is the C0 server boundary. The existing [compaction module](../../packages/kernel/src/compact.ts) and [recall regression](../../packages/adapter-pi-contact/src/recall.test.ts) are current evidence for their own behavior.

**Consolidation Gate.** Working context supplies evidence for `reflect`. `statedIn` ties the claim to the source, and [`planMemoryWrite`](../../packages/kernel/src/memory.ts) decides whether to reinforce or change existing knowledge. Keep foreign-key integrity for stored source references. This is the memory admission path into long-term carriers. D29 isolates plugins and harness execution. pstack compiles repeated engineering lessons into checks. Neither substitutes for deciding if a claim belongs in memory.

| Long-term memory | Carrier | Boundary |
| --- | --- | --- |
| Episodic | `gg_events` + `turns.jsonl` | Event and raw-turn provenance roles in the unified architecture. Check the current event and run stores and harness transcripts for the carriers actually landed. |
| Semantic | `gg_memory` + Markdown | Scope by trigger and anchors. Keep `updatedAt` and source provenance so a reader can trace, replace, or revoke a claim. See [memory store](../../packages/server/src/memory-store.ts) and [memory hygiene](../../packages/server/src/memory-hygiene.ts). |
| Procedural | Playbook → `SKILL.md` symlink projection → isolated Plugin & Harness | The landed [Playbook](../../packages/server/src/playbook.ts) records reusable observations. Symlink projection is a separate stage. D29 supplies an isolation boundary for executable procedures. Claim the stage-to-stage path only once its own PR lands and verifies it. |

One-off `artifacts` (AC-04) carry task output and evidence. Retain them with the task. A reusable procedure needs separate admission into the procedural path. See [artifacts.ts](../../packages/server/src/artifacts.ts) and the [progress checklist](../BACKEND-PROGRESS-CHECKLIST.md).
