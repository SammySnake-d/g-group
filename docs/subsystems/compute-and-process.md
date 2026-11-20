# Compute and Process

`packages/process-tools` owns isolated child process utilities. `packages/adapter-cc-compute` and `packages/adapter-codex-compute` adapt each harness to the kernel Compute ports. The server owns orchestration of task workspace state and leases.

Treat launch, stop, confirmed exit, and slot return as distinct steps. Verify handoff, stop, and log/cleanup behavior at the owned process boundary. Record actual binary and model coverage in the [progress checklist](../BACKEND-PROGRESS-CHECKLIST.md).

With `OPENAI_BASE_URL` configured, Codex Compute sets a Responses provider on `thread/start` and `thread/resume`. The native child reads its API key from `OPENAI_API_KEY` or `CODEX_API_KEY`. Each `turn/start` still takes the contact's effective Compute model.
