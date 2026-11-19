# Context and Memory

`packages/adapter-pi-contact` owns the contact request and recall wire path. The kernel owns round assembly, compaction, recall, and write planning. The server wires those pieces to durable storage and API views.

| Scope | Window | Admission and continuity |
| --- | --- | --- |
| Working, Contact | Five-block `CarryOn` | Block 1 admits global stable material and stays byte-identical across turns. No character or token cap (AC-42 ⑥, #2391). Blocks 2–5 carry changing round context. |
| Working, Compute | Isolated context for the Compute slot | Execution progress and transcript stay scoped to the slot and its harness. |

**Slice C0 (`bg-compact`).** Host commits each round’s actions and input cursor before starting model compaction. Block 3 combines the current note with the durable pending input batches. The [background compaction coordinator](../../packages/server/src/bg-compaction.ts) runs each contact’s jobs in order. It checks the note version, room access, and source inputs before adopting a result. Adoption advances the note through the job’s batch and keeps every newer batch. A failed or stale job leaves valid inputs available for the next job. An explicit state note clears the prior batches and fences older jobs. Host shutdown aborts the queue and waits for it to drain.

Expanded Block 5 memory and `read_memory` show update time, source when present, and replacement and refinement links. Block 1 still holds the stable global snapshot. Reflection and `remember` require the relation and target together, and write planning requires a nonempty target that resolves to a live entry. The [C0 proof](../../packages/server/proof/c0-bg-compaction-provenance.txt) records the deterministic backend checks.

**Consolidation Gate.** Working context supplies evidence for `reflect`. `statedIn` ties the claim to the source, and [`planMemoryWrite`](../../packages/kernel/src/memory.ts) decides whether to reinforce or change existing knowledge. Keep foreign-key integrity for stored source references. This is the memory admission path into long-term carriers. D29 isolates plugins and harness execution. pstack compiles repeated engineering lessons into checks. Neither substitutes for deciding if a claim belongs in memory.

| Long-term memory | Carrier | Boundary |
| --- | --- | --- |
| Episodic | `gg_events` + `turns.jsonl` | Event and raw-turn provenance roles in the unified architecture. Check the current event and run stores and harness transcripts for the carriers actually landed. |
| Semantic | `gg_memory` + Markdown | Scope by trigger and anchors. Keep `updatedAt` and source provenance so a reader can trace, replace, or revoke a claim. See [memory store](../../packages/server/src/memory-store.ts) and [memory hygiene](../../packages/server/src/memory-hygiene.ts). |
| Procedural | Playbook → `SKILL.md` symlink projection → isolated Plugin & Harness | The landed [Playbook](../../packages/server/src/playbook.ts) records reusable observations. Symlink projection is a separate stage. D29 supplies an isolation boundary for executable procedures. Claim the stage-to-stage path only once its own PR lands and verifies it. |

One-off `artifacts` (AC-04) carry task output and evidence. Retain them with the task. A reusable procedure needs separate admission into the procedural path. See [artifacts.ts](../../packages/server/src/artifacts.ts) and the [progress checklist](../BACKEND-PROGRESS-CHECKLIST.md).
