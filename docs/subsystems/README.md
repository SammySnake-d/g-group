# Backend Subsystem Index

Read the owning reference before changing a module. Server and kernel modules are grouped by the behavior they own. Update the matching reference in the same commit.

| Subsystem | Reference | Main package or script roots |
| --- | --- | --- |
| Contracts and bridge | [contracts-and-bridge.md](contracts-and-bridge.md) | `packages/api-contract`, `packages/ui-core`, server transport |
| Domain and state machines | [domain-and-state-machines.md](domain-and-state-machines.md) | `packages/domain`, `packages/kernel`, `packages/adapter-sqlite` |
| Context and memory | [context-and-memory.md](context-and-memory.md) | `packages/adapter-pi-contact`, kernel context and server memory |
| Contact and gateway | [contact-and-gateway.md](contact-and-gateway.md) | `packages/server`, `packages/adapter-pi-contact` |
| Compute and process | [compute-and-process.md](compute-and-process.md) | `packages/process-tools`, `packages/adapter-cc-compute`, `packages/adapter-codex-compute` |
| Plugins and commitments | [plugins-and-commitments.md](plugins-and-commitments.md) | Kernel plugin ports, domain commitment ledger, server runtime |
| Gates and autonomy | [gates-and-autonomy.md](gates-and-autonomy.md) | `scripts/`, `.githooks/` |

See the [agent guide](../../AGENTS.md), [code standards](../code-standards.md), and [lessons ledger](../../LESSONS.md).
