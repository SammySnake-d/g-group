// The desktop window does not run DSH.  Keep the upstream component contract,
// but provide the small primitives the g-group adapter needs locally.
import { createElement as h } from 'react'

export const FishLogo = ({ size = 24 } = {}) => h('span', { className: 'bt-fish-logo', style: { width: size, height: size }, 'aria-hidden': true }, '◉')

const inline = (text) => String(text ?? '').split(/(`[^`]+`)/g).map((part, index) => part.startsWith('`') && part.endsWith('`')
  ? h('code', { key: index }, part.slice(1, -1))
  : part)

export function MarkdownText({ text }) {
  const paragraphs = String(text ?? '').split(/\n\n+/)
  return h('div', { className: 'md_markdown' }, paragraphs.map((paragraph, index) => h('p', { key: index }, inline(paragraph))))
}

export const writeClipboard = (text) => navigator.clipboard?.writeText(String(text ?? '')).then(() => true, () => false)

