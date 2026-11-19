# G-Group Backend Agent Guide

Read [LESSONS.md](LESSONS.md) before changing source. G-Group is an IM workspace for people and agents. The backend owns durable state, runtime orchestration, and the shared API contract.

## Mandatory pre-change workflow

1. Find the owner in the [subsystem index](docs/subsystems/README.md) and read its reference.
2. Check [code standards](docs/code-standards.md) before changing boundaries, code, or tests.
3. Update owning docs and contract baselines in the same PR. Commit the docs with the code whose behavior or ownership changed.
4. Keep the slice small and focused on one goal. Clean up temporary directories, logs, and test processes.

## Five core domain entities

| Entity | Owns |
| --- | --- |
| **Contact** | Agent identity and configuration, avatar and presence, speaking model, and separate Compute harness (`claude-code` or `codex`) and model slots. |
| **Room** | DM or group conversation, membership, stream sequence, announcements, and conversation context for the split layout. |
| **Message** | Ordered chat stream (`seq`), replies, quotes, reactions, forwards, cards, drafts, and attachments. |
| **Task** | Explicit collaboration item with status, owner, timeline, and deliverables. Supplies the Panorama board. |
| **Compute** | Task execution, workspace lifecycle, and inspector transcript. A Compute slot has its own context and lease. |

## Six package layers

Read from foundations toward composition: **domain → kernel / process → adapter → plugin → app**. Imports point toward foundations, subject to the [layer gate](scripts/gates/gates.ts). Domain owns pure rules and wire types. Kernel owns pure orchestration and ports. Process is isolated and implements process lifecycle primitives. Adapters connect to I/O and harnesses. Plugins run behind a serialized isolation boundary. App wires ports and serves the contract. Neither domain nor kernel imports Node I/O.

## Unified memory architecture

Working memory has two windows. The contact's five-block `CarryOn` admits global stable material into Block 1 and preserves those bytes across turns. Dynamic material belongs in later blocks. The Compute slot keeps its own execution window. Upcoming Slice **C0** (`bg-compact`) adds a dual cursor for background compaction. Its adoption contract preserves the lossless recent delta up to the compaction watermark and all newer turns across handoff.

The **Consolidation Gate** joins these windows to three long-term memory types. Reflection (`reflect`), `statedIn` evidence, and `planMemoryWrite` decide what to record, with foreign-key integrity for source references. D29 isolation and pstack compiled gates enforce execution and engineering boundaries separately from memory admission.

| Long-term type | Carrier or progression |
| --- | --- |
| Episodic | `gg_events` + `turns.jsonl` keep the event and transcript trail. Treat these as architecture roles and check the owning doc for current carriers. |
| Semantic | `gg_memory` + Markdown, with trigger-scope indexing and `updatedAt` / source provenance. |
| Procedural | Playbook → `SKILL.md` symlink projection → isolated Plugin & Harness. Each stage needs its own landed proof. |

One-off `artifacts` (AC-04) are task output and evidence. Reusable procedures enter memory through their own admission path. See [Context and Memory](docs/subsystems/context-and-memory.md) for implementation status. Claim each capability only after its PR lands.

## Canonical commands

- `npm run check` runs docs, contracts, structure, and typecheck.
- `npm test` runs package and gate tests.
- `npm run gates` checks the branch against its base.
- `npm run gates:selftest` verifies the gate machinery.
- `./scripts/merge.sh <PR>` is the protected merge entry point.
