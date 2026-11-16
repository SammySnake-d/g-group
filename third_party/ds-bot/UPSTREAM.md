# DS-Bot visual adaptation

This worktree uses the DS-Bot desktop shell as a visual reference and adapts
its quiet paper surface, left conversation navigation, centered title pill,
large message composer and compact Bot/group rows to g-group's existing React
renderer. The live g-group backend, store, API contracts, domain entities and
Electron security boundary remain the source of truth.

- Repository: <https://github.com/Fei2411/DS-Bot>
- Frozen commit: `a66cc737cfb6c3d8a2597e748cded6cab1206dd3`
- License: Apache-2.0
- Upstream evidence: `/tmp/ds-bot-feasibility-20261116/repo`
- Adapted files: `apps/desktop/src/dsbot/theme.ts`, `apps/desktop/src/app/list/ListPane.tsx`, `apps/desktop/src/app/chat/ChatHeader.tsx`, `apps/desktop/src/components/Composer.tsx`, and `apps/desktop/src/index.css`.

The DS-Bot product name, marks, DSH plugin protocol and DSH-only settings are
not shipped as g-group runtime capabilities.
