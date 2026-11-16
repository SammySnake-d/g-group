import { createElement as h } from 'react'
import { CellEmpty } from './cell-empty.js'

// g-group keeps the DS-Bot transcript renderer, but its first closed-loop slice
// does not expose DSH's interactive widget protocol. These exports preserve the
// upstream cells contract and leave unsupported cards out of the transcript.
export const ViewCard = () => h(CellEmpty)
export const WidgetView = () => h(CellEmpty)
export const ViewMenuList = () => h(CellEmpty)
export const PendingView = () => h(CellEmpty)
export const WidgetCell = () => h(CellEmpty)
export const WidgetDock = () => null
export const AnsweredView = () => h(CellEmpty)
export const AnsweredReply = () => h(CellEmpty)
export const WIDGET_CSS = ''
export const ClosedView = ({ title }) => h('div', { className: 'bt-event' }, title ?? '')
