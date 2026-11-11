// 应用壳(不是宿主合同)的接口:接入模型、版本与更新。主进程(electron/app-ipc.ts)和渲染层(api/app-shell.ts)共用这份类型。
// 宿主的业务接口仍只走 @g-group/api-contract(window.gg);这里只管「这个应用本身」的事。

/** 模型网关:联系人说话(pi)和 Compute(claude 命令)都经它连模型。令牌只进不出,读回只给 hasToken。 */
export interface GatewayView {
  baseUrl: string
  model: string
  hasToken: boolean
}

/** 后端(主进程内的宿主)现在的状态 */
export type BackendRun =
  | { state: 'off'; reason: string }
  | { state: 'needs-setup' }
  | { state: 'running'; mind: 'fake' | 'pi'; compute: 'fake' | 'claude' }
  | { state: 'failed'; reason: string }

export interface SetupView {
  gateway: GatewayView | null
  /** Compute 用的 claude 命令;null = 没找到 */
  claudePath: string | null
  backend: BackendRun
}

export interface SetupInput {
  baseUrl: string
  model: string
  /** 不填 = 沿用已存的令牌 */
  token?: string
}

export type UpdatePhase = 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'installing' | 'error' | 'unsupported'
export interface UpdateState {
  phase: UpdatePhase
  current: string
  latest?: string
  /** downloading:已收 / 总字节 */
  received?: number
  size?: number
  /** idle:上次检查的结论(已是最新 / 还没有发布过版本);error / unsupported:原因与怎么办 */
  note?: string
  checkedAt?: string
}

export interface AppInfo {
  version: string
  packaged: boolean
  platform: string
  arch: string
}

/** 方法表:方法名 → [参数, 结果] */
export interface AppShellMethods {
  'app.info': [Record<string, never>, AppInfo]
  'setup.get': [Record<string, never>, SetupView]
  'setup.save': [SetupInput, SetupView]
  'setup.detectClaude': [Record<string, never>, SetupView]
  'update.get': [Record<string, never>, UpdateState]
  'update.check': [Record<string, never>, UpdateState]
  'update.download': [Record<string, never>, UpdateState]
  'update.install': [Record<string, never>, UpdateState]
}
export type AppShellMethod = keyof AppShellMethods
export const APP_SHELL_METHODS: readonly AppShellMethod[] = ['app.info', 'setup.get', 'setup.save', 'setup.detectClaude', 'update.get', 'update.check', 'update.download', 'update.install']

export type AppShellResult<M extends AppShellMethod> = { ok: true; value: AppShellMethods[M][1] } | { ok: false; error: string }
export type AppShellEvent = { type: 'update'; state: UpdateState }

export interface AppShellBridge {
  invoke<M extends AppShellMethod>(method: M, params: AppShellMethods[M][0]): Promise<AppShellResult<M>>
  subscribe(listener: (e: AppShellEvent) => void): () => void
}

export const APP_IPC = { invoke: 'gg-app:invoke', event: 'gg-app:event' } as const
