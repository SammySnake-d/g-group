# Plugins and Commitments

The kernel defines serialized plugin ports and the domain owns the commitment ledger. The server composes [plugin runtime](../../packages/server/src/plugin-runtime.ts), scheduling, and delivery. Apply D29 isolation so a failed plugin is confined to its worker or subprocess. Keep delivery outcome, commitment state, and plugin runtime state distinct.

Use plugin and commitment tests to verify host survival, delivery outcome, and late response handling. Track upcoming runtime coverage in the [progress checklist](../BACKEND-PROGRESS-CHECKLIST.md).
