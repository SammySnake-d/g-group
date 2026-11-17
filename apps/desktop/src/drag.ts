/* AC-49：拖人进群 / 拖出群。HTML5 拖拽在 dragover 时读不到 dataTransfer 内容，这里记一下正在拖谁、从哪来 */
import type { PersonId } from '@/data'
export const drag: { who: PersonId | null; from: 'contact' | 'member' | null } = { who: null, from: null }
export const startDrag = (e: React.DragEvent, who: PersonId, from: 'contact' | 'member') => {
  drag.who = who; drag.from = from
  e.dataTransfer.setData('text/plain', who); e.dataTransfer.effectAllowed = 'move'
}
export const endDrag = () => { drag.who = null; drag.from = null }
