/**
 * DS-Bot frontend provenance for the vendored renderer.
 *
 * The live renderer is mounted from dsbot-base/upstream. g-group keeps its own
 * domain objects, store and backend wire; this record makes the source and
 * license visible to the settings/about surface.
 */
export const DS_BOT_FRONTEND_SOURCE = {
  repository: 'https://github.com/Fei2411/DS-Bot',
  commit: 'a66cc737cfb6c3d8a2597e748cded6cab1206dd3',
  license: 'Apache-2.0',
} as const

export const DS_BOT_THEME = {
  accent: 'var(--dsbot-accent)',
  accentSoft: 'var(--dsbot-accent-soft)',
  paper: 'var(--dsbot-paper)',
  side: 'var(--dsbot-side)',
  ink: 'var(--dsbot-ink)',
  quiet: 'var(--dsbot-quiet)',
  line: 'var(--dsbot-line)',
} as const
