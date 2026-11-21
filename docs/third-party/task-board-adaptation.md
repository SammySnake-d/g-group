# Task-board adaptation provenance

This slice is an independent adaptation of the task-board ideas in
[`deepseek-ai/deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness),
MIT licensed, commit `2e39e704`.

The adapted ideas are exclusive task-item claiming, compare-and-swap revision
semantics, release back to pending, user-controlled reassignment, and the
model-facing claim/update policy. The implementation stays on g-group's
existing `Task` document, SQLite transaction, attention loop, Compute lifecycle,
and ordinary room messages. No DeepSeek source file or test file is copied into
this repository.

The upstream project retains its MIT copyright and license in its own
repository. This file records provenance for the behavior adapted here.
