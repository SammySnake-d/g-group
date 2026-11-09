// 界面状态的领域类型(原 ctx.ts)。ctx.ts 继续原样导出这些类型,外部 import 不用改。
import type { PulseItem, Board, Commitment, Compute, Conversation, Pending, PersonId, PlaybookItem, QuoteRef, Cron, ListItem, PluginState } from '@/data'
import type { PluginAction, PluginManifest, PluginResult } from '@g-group/ui-core'

/** 右侧浮层是一摞页面：打开新页压栈，返回/关闭只弹出一层（群资料 → 成员资料 → 关闭 = 回到群资料） */
export type Page =
  | { t: 'person'; id: PersonId }
  | { t: 'personTools'; id: PersonId }
  | { t: 'inner'; id: PersonId; conv: string } // 从群聊私信
  | { t: 'detail'; id: PersonId; conv: string; tab?: 'me' | 'agents' | 'work' | 'memory' } // 查看对话细节
  | { t: 'talk'; id: string }
  | { t: 'workspace'; id: string }
  | { t: 'pins'; id: string }
  | { t: 'members'; id: string }
  | { t: 'files'; id: string }
  | { t: 'group'; id: string }
  | { t: 'pool'; id: string }
  | { t: 'links'; id: string }
  | { t: 'linkPick'; id: string }
  | { t: 'playbook'; id: string }
  | { t: 'commits'; id: string }
  | { t: 'clone'; id: string }
  | { t: 'search'; id: string }
  | { t: 'huddle'; conv: string; msgId: string }
  | { t: 'forwardView'; conv: string; msgId: string }
  | { t: 'forwardPick'; from: string; msgIds: string[] }
  | { t: 'helper' }
  | { t: 'settings' }
  | { t: 'addContact' }
  | { t: 'newGroup' }
  | { t: 'sources' }
  | { t: 'source'; id: string }
  | { t: 'process'; id: PersonId; conv?: string } // 联系人的完整过程：同一套聊天模板，只有它一个人说话；conv 有值 = 只看本群
  | { t: 'cron'; id: string }
  | { t: 'task'; id: string }

export type SplitTab = { t: 'compute'; id: string; view?: CView } | { t: 'artifact'; id: string } | { t: 'contact'; id: PersonId; conv?: string; tab?: 'here' | 'talks' | 'process' | 'duty' | 'memory' } | { t: 'cron'; id: string } | { t: 'group'; id: string; tab?: 'members' | 'notice' | 'list' | 'cron' | 'plugin' | 'tools' }
/** Compute 视图页签;'session' = harness 原始会话(#1005,默认选中) */
export type CView = 'session' | 'activity' | 'diff' | 'preview' | 'checks' | 'checkpoints'

/** A2UI 提问卡片的回答记录(按提问消息 id):卡片答完收起成「标题 · 选了什么」,你的回答消息也显示成同一张收起的卡片 */
export interface Answer { title: string; options: string[]; picked: string; at: string; replyId: string }

export interface Ctx {
  answers: Record<string, Answer>
  computes: Record<string, Compute>
  pending: Pending[]
  convs: Conversation[]
  boards: Record<string, Board>
  commits: Commitment[]
  playbook: PlaybookItem[]
  reactions: Record<string, Record<string, PersonId[]>>
  active: string
  dark: boolean
  debug: boolean
  typing: Record<string, PersonId | null>
  setDark: (v: boolean) => void
  setDebug: (v: boolean) => void
  /** 压栈打开；root=true 时先清空再打开（从别处直接进来） */
  push: (p: Page, root?: boolean) => void
  back: () => void
  closeAll: () => void
  openSplit: (t: SplitTab) => void
  setPanoOpen: (v: boolean) => void
  openConv: (id: string) => void
  openDm: (id: PersonId) => void
  mention: (id: PersonId) => void
  addQuote: (q: QuoteRef) => void
  react: (msgId: string, emoji: string) => void
  jump: (msgId: string) => void
  resolve: (pid: string, action: string, value?: string | number) => void
  stop: (cid: string) => void
  resume: (cid: string) => void
  tell: (cid: string, text: string, sideAsk?: boolean) => void
  rollback: (cid: string, cpId: string) => void
  retag: (msgId: string, task: string | null) => void
  setDisp: (msgId: string, d: import('@/data').Disp | undefined) => void
  claim: (boardId: string, row: number, who: PersonId) => void
  addMembers: (convId: string, ids: PersonId[], by?: PersonId) => void
  removeMember: (convId: string, id: PersonId) => void
  createContact: (p: { name: string; role: string; shape: string; color: string; model: string; quota: number }) => void
  createGroup: (title: string, ids: PersonId[], sys?: string, pool?: number) => string
  quoteExternal: (lines: { who: string; text: string }[], app: string) => void
  linkConv: (convId: string, other: string) => void
  unlinkConv: (convId: string, other: string) => void
  forward: (from: string, msgIds: string[], to: string) => void
  sendAs: (convId: string, text: string) => void
  importBoard: (convId: string) => void
  setSelecting: (on: boolean) => void
  showPip: (cid: string | null) => void
  setNotice: (convId: string, text: string) => void
  /** 改某一条公告：版本号 +1，助手下次接活 / 醒来装配新版本（U86） */
  editNotice: (convId: string, noticeId: string, text: string) => void
  setConvFlag: (convId: string, flag: 'pinned' | 'muted', v: boolean) => void
  markRead: (convId: string) => void
  recall: (msgId: string) => void
  reedit: (text: string) => void
  /** AC-48：私聊回到某条消息。之后的消息撤下、由它们派生的待你回答作废；可恢复 */
  rewind: (convId: string, msgId: string) => void
  unrewind: (sysId: string) => void
  rewindAsk: string | null
  setRewindAsk: (msgId: string | null) => void
  renameConv: (convId: string, title: string) => void
  toast: (text: string) => void
  decideVote: (msgId: string, opt: number) => void
  poke: (id: PersonId) => void
  silence: (convId: string, id: PersonId) => void
  pinMsg: (convId: string, msgId: string) => void
  deleteMsgs: (ids: string[]) => void
  leaveConv: (id: string, dissolve: boolean) => void
  /** U09：群主设本群临时算力上限（0 = 不给） */
  setPool: (convId: string, max: number) => void
  deleteMsg: (msgId: string) => void
  openContact: (id: PersonId, conv?: string, tab?: 'here' | 'talks' | 'process' | 'duty' | 'memory') => void
  summarize: (convId: string) => void
  /** C-US08：编辑自己发过的消息 → 标已编辑；在回它的助手作废旧草稿、按新内容重写 */
  editMsg: (msgId: string, text: string) => void
  editing: string | null
  setEditing: (id: string | null) => void
  clearHistory: (convId: string) => void
  updatePerson: (id: PersonId, patch: Partial<import('@/data').Person>, note: string) => void
  /* ---- v4 ---- */
  crons: Cron[]
  pulse: PulseItem[]
  checklist: ListItem[]
  /** 本机插件安装状态（ui-core 的 PluginInstall + 凭据说明 + 外发预授权） */
  plugins: PluginState[]
  /** 插件市场目录：各插件最新版本的清单 */
  pluginCatalog: PluginManifest[]
  /** 左侧当前所在的一级区域；从“进展”“联系人”打开东西时不切走它（#1387） */
  section: Section
  setSection: (s: Section) => void
  /** 联系人工作台：主面板展开（#1334） */
  openWorkbench: (id: PersonId, tab?: WbTab) => void
  /** Helper 局部面板（聊天窗口里并排，只读当前聊天） */
  helperPanel: boolean
  setHelperPanel: (v: boolean) => void
  /** Helper 全局（⌘K，默认什么都不读） */
  helperGlobal: boolean
  setHelperGlobal: (v: boolean) => void
  /** 在聊天里 @Helper：回复作为这个聊天的一条消息 */
  helperReply: (convId: string, ask: string) => void
  claimTask: (taskId: string, who: PersonId) => void
  setTaskStatus: (taskId: string, st: ListItem['status']) => void
  addTasks: (convId: string, texts: string[]) => void
  /** 手动新建一项（群资料·清单·新建）：标题、描述分开存，指了人就直接进行中 */
  addTask: (t: { text: string; desc?: string; who?: PersonId; conv: string }) => string
  updateCron: (id: string, patch: Partial<Cron>) => void
  /** 新建定时；下次运行由 trigger 现算，runs 从空开始 */
  addCron: (c: Omit<Cron, 'id' | 'runs'>, via: 'chat' | 'panel') => string
  removeCron: (id: string) => void
  runCronNow: (id: string) => void
  /** 只改凭据说明、预授权这些附加信息；安装状态走 pluginAct */
  updatePlugin: (id: string, patch: Partial<Pick<PluginState, 'cred' | 'grant'>>) => void
  /** 推进插件生命周期（ui-core pluginReducer）。非法转移原样返回错误，不改状态；安装 / 卸载会在演示里稍后自动完成 */
  pluginAct: (id: string, a: PluginAction) => PluginResult<PluginState>
  /** 把 /命令 填进当前聊天的输入框（工具页签用；补全菜单在输入框那边） */
  putCommand: (name: string) => void
  /** AC-35⑤：凭据失效（原型里用按钮模拟）/ 重新授权 */
  /** C-US15：卡在验证码 → 交给你；你接手、过了以后交还，它接着做 */
  hitCaptcha: (cid: string) => void
  declineHuman: (cid: string) => void
  takeHuman: (cid: string) => void
  returnHuman: (cid: string) => void
  revokePlugin: (id: string) => void
  reauthPlugin: (id: string) => void
  pushMsg: (m: import('@/data').Msg, convId: string) => void
  /** 定时草稿：/schedule 带过来的「何时 / 做什么」。openSchedule(草稿) 打开定时编辑并预填，null 关掉；
   *  定时编辑器读 scheduleDraft 预填（现在由输入框里的定时弹窗读，定时模块换新编辑器时接同一份） */
  scheduleDraft: ScheduleDraft | null
  openSchedule: (d: ScheduleDraft | null) => void
  /** 模型配置（D07.4）：全局默认与模型目录。全软件只在设置页「默认」和联系人工作台「设置」两处改 */
  modelSettings: import('@/modelConfig').ModelSettings
  /** 每保存一次模型配置 +1：别处打开着的配置页据此刷新 */
  modelsRev: number
  /** 一次写入：全局默认 + 若干联系人的模型字段（每位联系人在私聊里留一条记录） */
  saveModels: (s: { settings?: Partial<import('@/modelConfig').ModelSettings>; contacts?: { id: PersonId; patch: Partial<import('@/data').Person>; note: string }[]; toast?: string }) => void
}

export interface ScheduleDraft { conv: string; when?: string; what?: string; via: 'slash' }

export type Section = 'chat' | 'contacts' | 'activity' | 'files' | 'plugins'
export type WbTab = 'overview' | 'duty' | 'memory' | 'cron' | 'settings' | 'process'

