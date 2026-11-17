declare module '*ds-bot/src/shared/mentions.js' {
  export function mentionSpans<T extends { id: string; name: string }>(text: string, bots: T[], options?: { references?: string[] }): Array<{ start: number; end: number; bot?: T; all?: boolean }>
}
