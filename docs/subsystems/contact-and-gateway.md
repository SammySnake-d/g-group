# Contact and Gateway

`packages/server` wires Contact lifecycle, configuration snapshots, speaking turns, provider discovery, and usage. `packages/adapter-pi-contact` implements contact speaking and provider request wiring. Select the speaking model independently from the Compute model and harness. A turn captures its config snapshot, so a later edit takes effect at the next eligible boundary.

Changes to wire routing or prompt caching need adapter tests. Changes to the snapshot and rollback path need server tests. Contact context and Block 1 admission belong to [Context and Memory](context-and-memory.md).

### Group follow-up

The contact finds open and owned tasks in the current context and can read the task's requirement, owner, state, and revision with `read_task`. `claim_task` and `release_task` carry the read revision and the contact's own room message. A contact that loses a claim receives the winner's name through the existing private round inbox. In a round proposing a claim on an existing task, `dispatch_compute` cannot also create a task from the same room's latest user message. Other source messages and claims of other existing items aren't blocked by this check.

Contact replies wake other room members from the durable message. The default runtime has no per-root wake count cap and no two-post cap for a room without a human reply. Explicit limits set by an embedding host still apply. A root stopped by the former default may accept a new wake after upgrade. Prior stop messages remain in chat history, and delivery still deduplicates the same message and target. The separate identical-post, sender-rate, and three-sender ring rules retain their existing behavior.

At reply commit, the host resolves visible `@name` tokens against unique peers in the current room and records their contact IDs in `mentions`. The prompt identifies the sender and the explicit recipients separately. Group replies to a quoted and addressed user message go to its named contacts, who follow the new request and use the quoted text as background. An explicit request for silence applies to that message and its follow-ups. Named contacts can respond, and repeating the same acknowledgement on that thread does not post a second copy. Observers still process shared context and can contribute new information in ordinary discussion.
