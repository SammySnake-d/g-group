# DS-Bot frontend base

This worktree vendors the DS-Bot client renderer from the frozen upstream
commit and mounts its actual sidebar, header pill, conversation rows, avatar
marks, composer primitives and CSS in the g-group renderer. The g-group adapter
owns the roster mapping, message/file actions and dialogs; the g-group backend,
API contracts, domain entities and Electron security boundary remain the source
of truth.

- Repository: <https://github.com/Fei2411/DS-Bot>
- Frozen commit: `a66cc737cfb6c3d8a2597e748cded6cab1206dd3`
- License: Apache-2.0
- Upstream evidence: `/tmp/ds-bot-feasibility-20261116/repo`
- Vendored client source: `apps/desktop/src/dsbot-base/upstream/ds-bot/src/client/` and `apps/desktop/src/dsbot-base/upstream/ds-bot/src/shared/`.
- g-group adapter: `apps/desktop/src/dsbot-base/DsBotApp.tsx` and `apps/desktop/src/dsbot-base/styles.css`.

The vendored client keeps the upstream component and CSS structure. Three
DSH-only seams are intentionally replaced at the adapter boundary:
`dsh-primitives.js` supplies local Markdown/clipboard primitives,
`widget-cell.js` leaves unsupported DSH widgets empty, and `user-message.js`
uses local text/file helpers. Those seams do not change the g-group API or
bring the DSH plugin protocol into the product.

The DS-Bot product name, DSH plugin protocol and DSH-only settings are not
shipped as g-group runtime capabilities. The renderer uses the upstream marks
and layout components, while g-group supplies its own product name, domain
actions and backend protocol.
