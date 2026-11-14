import { SetupForm } from './SetupForm'

/* 首次打开(或上次没连上)时整个窗口就是这一件事:接入模型。不铺演示数据,不弹窗——没有模型什么都跑不起来。
   顶部留出 macOS 红绿灯与拖动区。 */
export function SetupScreen() {
  return (
    <div data-testid="setup-screen" className="relative flex h-full min-h-[640px] flex-col bg-bg text-fg">
      <div aria-hidden className="h-10 shrink-0 [-webkit-app-region:drag]" />
      <main className="flex min-h-0 flex-1 items-start justify-center overflow-y-auto px-6 pb-12 pt-[12vh]">
        <div className="w-full max-w-[400px]">
          <h1 className="text-[22px] font-semibold tracking-[-0.01em] [text-wrap:balance]">接入模型，开始用 g-group</h1>
          <p className="mb-7 mt-2 text-[13.5px] leading-relaxed text-fg-2 [text-wrap:pretty]">联系人说话、Compute 干活都经这个网关连模型。填一次就行，以后在设置里改。</p>
          <SetupForm />
        </div>
      </main>
    </div>
  )
}
