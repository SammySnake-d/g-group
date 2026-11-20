# Contact and Gateway

`packages/server` wires Contact lifecycle, configuration snapshots, speaking turns, provider discovery, and usage. `packages/adapter-pi-contact` implements contact speaking and provider request wiring. Select the speaking model independently from the Compute model and harness. A turn captures its config snapshot, so a later edit takes effect at the next eligible boundary.

Changes to wire routing or prompt caching need adapter tests. Changes to the snapshot and rollback path need server tests. Contact context and Block 1 admission belong to [Context and Memory](context-and-memory.md).

### Group follow-up

Contact replies wake other room members from the durable message. The default runtime has no per-root wake count cap and no two-post cap for a room without a human reply. Explicit limits set by an embedding host still apply. A root stopped by the former default may accept a new wake after upgrade. Prior stop messages remain in chat history, and delivery still deduplicates the same message and target. The separate identical-post, sender-rate, and three-sender ring rules retain their existing behavior.
