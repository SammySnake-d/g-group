# Contact and Gateway

`packages/server` wires Contact lifecycle, configuration snapshots, speaking turns, provider discovery, and usage. `packages/adapter-pi-contact` implements contact speaking and provider request wiring. Select the speaking model independently from the Compute model and harness. A turn captures its config snapshot, so a later edit takes effect at the next eligible boundary.

Changes to wire routing or prompt caching need adapter tests. Changes to the snapshot and rollback path need server tests. Contact context and Block 1 admission belong to [Context and Memory](context-and-memory.md).
