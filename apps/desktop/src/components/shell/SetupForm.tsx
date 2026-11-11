import { useState } from 'react'
import { CircleAlert, CircleCheck, RotateCw } from 'lucide-react'
import { shellCall, useAppShell } from '@/api/app-shell'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { Field, TextInput, ctaDisabled } from '@/components/pages/kit/parts'
import { cn } from '@/lib/utils'

/* 接入模型的表单:首次打开的整窗页和设置页共用。
   主动作只有一个「保存并连接」;claude 命令检测只在会影响下一步时出声(没找到 → 派活会失败 → 重新检测)。 */
export function SetupForm({ submitLabel = '保存并连接', onSaved }: { submitLabel?: string; onSaved?: () => void }) {
  const setup = useAppShell((s) => s.setup)
  const [baseUrl, setBaseUrl] = useState(setup?.gateway?.baseUrl ?? '')
  const [model, setModel] = useState(setup?.gateway?.model ?? '')
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(setup?.backend.state === 'failed' ? `上次没连上：${setup.backend.reason}` : null)
  const [detecting, setDetecting] = useState(false)
  const hasToken = !!setup?.gateway?.hasToken
  const ready = baseUrl.trim() && model.trim() && (token.trim() || hasToken)

  const save = async () => {
    setBusy(true)
    setError(null)
    const r = await shellCall('setup.save', { baseUrl, model, ...(token.trim() ? { token } : {}) })
    setBusy(false)
    if (!r.ok) { setError(r.error); return }
    useAppShell.setState({ setup: r.value })
    if (r.value.backend.state === 'failed') setError(`保存了，但没连上：${r.value.backend.reason}`)
    else { setToken(''); onSaved?.() }
  }
  const detect = async () => {
    setDetecting(true)
    const r = await shellCall('setup.detectClaude', {})
    setDetecting(false)
    if (r.ok) useAppShell.setState({ setup: r.value })
  }

  return (
    <form data-testid="setup-form" className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); if (ready && !busy) void save() }}>
      <Field label="网关地址"><TextInput data-testid="setup-base-url" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.anthropic.com" autoComplete="off" spellCheck={false} inputMode="url" /></Field>
      <Field label="令牌" aside={hasToken ? <span className="text-[11.5px] font-normal text-fg-3">已保存，不改就留空</span> : undefined}>
        <TextInput data-testid="setup-token" type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder={hasToken ? '••••••••' : 'sk-…'} autoComplete="off" />
      </Field>
      <Field label="模型"><TextInput data-testid="setup-model" value={model} onChange={(e) => setModel(e.target.value)} placeholder="claude-sonnet-4-6" autoComplete="off" spellCheck={false} /></Field>
      {error && <p role="alert" data-testid="setup-error" className="flex items-start gap-1.5 text-[12.5px] leading-snug text-err"><CircleAlert className="mt-px h-3.5 w-3.5 shrink-0" />{error}</p>}
      <Button data-testid="setup-save" type="submit" variant="primary" size="md" className={cn('w-full', ctaDisabled)} disabled={!ready || busy}>
        {busy ? <><Spinner size="sm" tone="current" />正在连接…</> : submitLabel}
      </Button>
      <ClaudeLine path={setup?.claudePath ?? null} detecting={detecting} onDetect={detect} />
    </form>
  )
}

function ClaudeLine({ path, detecting, onDetect }: { path: string | null; detecting: boolean; onDetect: () => void }) {
  if (path) {
    return (
      <p data-testid="setup-claude" data-found="1" className="flex min-w-0 items-center gap-1.5 text-[12px] text-fg-3">
        <CircleCheck className="h-3.5 w-3.5 shrink-0 text-ok" />
        <span className="shrink-0">Compute 用本机的</span><span className="min-w-0 truncate font-mono text-[11.5px]" title={path}>{path}</span>
      </p>
    )
  }
  return (
    <div data-testid="setup-claude" data-found="0" className="flex items-start gap-2 rounded-lg bg-err-soft px-3 py-2.5 text-[12.5px] leading-snug text-fg">
      <CircleAlert className="mt-px h-3.5 w-3.5 shrink-0 text-err" />
      <span className="min-w-0 flex-1">没找到 <span className="font-mono text-[12px]">claude</span> 命令，派给 Compute 的活会失败。装好 Claude Code 后点重新检测。</span>
      <Button type="button" variant="ghost" size="xs" className="-my-1 shrink-0" onClick={onDetect} disabled={detecting}>
        <RotateCw className={cn(detecting && 'motion-safe:animate-spin')} />重新检测
      </Button>
    </div>
  )
}
