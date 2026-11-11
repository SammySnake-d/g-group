/* 定时编辑器（新建和修改共用）。外壳是居中对话框;表单在 EditorBody。
   什么时候醒有四种：按时间重复（预设芯片 + 自定义 cron，逐段校验、人话说明、接下来几次）/ 只跑一次 / 每 N 条消息 / 某件事发生（插件来源）。
   时刻一律按本地时区算，界面写明是哪个时区。 */
import type { Cron, PersonId } from '@/data'
import { Modal } from '@/components/ui/modal'
import { EDITOR } from './constants'
import { EditorBody, type CronDraft } from './EditorBody'

export type { CronDraft }

export function CronEditor({ open, init, seed, conv, owner, onClose, onSave }: {
  open: boolean
  /** 有 = 修改这个定时 */
  init?: Cron
  /** 新建时从别处带来的预填(如 /schedule <何时> <做什么>):做什么、cron 表达式 */
  seed?: { text?: string; expr?: string }
  /** 新建时预填的会话 / 助手 */
  conv?: string
  owner?: PersonId
  onClose: () => void
  onSave: (d: CronDraft) => void
}) {
  return (
    <Modal open={open} onClose={onClose} testid="cron-editor" width={640} title={init ? EDITOR.titleEdit : EDITOR.titleNew} description={EDITOR.desc}
      /* Esc 只关这张卡，不让外层顺带收起分屏 */
      onEscapeKeyDown={(e) => e.stopPropagation()}>
      <EditorBody init={init} seed={seed} conv={conv} owner={owner} onClose={onClose} onSave={onSave} />
    </Modal>
  )
}
