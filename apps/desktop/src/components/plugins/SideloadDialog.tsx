/* 从文件或地址安装:清单先在本机逐条校验;下载安装包、核对签名要连接后端,如实说明,不假装装好。 */
import { useRef, useState } from 'react'
import { Check, FileUp } from 'lucide-react'
import { readInstallSource, type InstallSource, type PluginManifest } from '@g-group/ui-core'
import { Fade } from '@animate-ui/react/primitives/effects/fade'
import { useApp } from '@/ctx'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/field'
import { Modal, ModalBody, ModalFooter } from '@/components/ui/modal'
import { COPY } from './constants'
import { CategoryTag, CommandTag, PluginIcon, RiskBadge } from './tags'

export function SideloadDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  /* 草稿留在外层:关掉再打开,粘贴过的清单还在 */
  const [text, setText] = useState('')
  const [res, setRes] = useState<InstallSource | null>(null)
  return (
    <Modal open={open} onClose={onClose} testid="plg-sideload" width={620} title={COPY.sideloadTitle} description={COPY.sideloadDesc}
      icon={<span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-hover text-fg-2"><FileUp className="h-5 w-5" /></span>}>
      <SideloadBody text={text} setText={setText} res={res} setRes={setRes} onClose={onClose} />
    </Modal>
  )
}

function SideloadBody({ text, setText, res, setRes, onClose }: { text: string; setText: (t: string) => void; res: InstallSource | null; setRes: (r: InstallSource | null) => void; onClose: () => void }) {
  const fileRef = useRef<HTMLInputElement>(null)
  const check = (t = text) => setRes(readInstallSource(t))
  return (
    <>
      <ModalBody>
        <Textarea data-testid="plg-sideload-input" aria-label={COPY.sideloadTitle} value={text} onChange={(e) => { setText(e.target.value); setRes(null) }} rows={7} spellCheck={false}
          placeholder={COPY.sideloadPlaceholder} className="resize-none rounded-xl font-code text-[12.5px]" />
        <div className="mt-2 flex items-center gap-1.5">
          <input ref={fileRef} type="file" accept=".json,application/json" className="hidden" data-testid="plg-sideload-file"
            onChange={async (e) => { const f = e.target.files?.[0]; if (!f) return; const t = await f.text(); setText(t); check(t); e.target.value = '' }} />
          <Button variant="outline" onClick={() => fileRef.current?.click()}><FileUp />选择文件</Button>
          {text && <Button variant="ghost" onClick={() => { setText(''); setRes(null) }}>清空</Button>}
          <span className="flex-1" />
          <Button data-testid="plg-sideload-check" variant="primary" disabled={!text.trim()} onClick={() => check()}>校验</Button>
        </div>
        {res && res.kind !== 'empty' && <Fade key={JSON.stringify(res)} className="mt-3 pb-1"><Result res={res} /></Fade>}
      </ModalBody>
      <ModalFooter>
        <span className="flex-1" />
        <Button variant="ghost" onClick={onClose}>关闭</Button>
        <Button data-testid="plg-sideload-install" variant="primary" disabled title="需要连接后端">安装（需要连接后端）</Button>
      </ModalFooter>
    </>
  )
}

function Result({ res }: { res: Exclude<InstallSource, { kind: 'empty' }> }) {
  if (res.kind === 'invalid') return <p data-testid="plg-sideload-errors" className="rounded-xl border border-err/30 bg-err-soft px-3.5 py-2.5 text-[13px] text-err">{res.error}</p>
  if (res.kind === 'url') {
    return (
      <p data-testid="plg-sideload-backend" className="rounded-xl bg-hover px-3.5 py-2.5 text-[13px] leading-relaxed text-fg-2">
        地址格式没问题：<span className="break-all font-code text-[12px] text-fg">{res.url}</span><br />{COPY.sideloadUrlBackend}
      </p>
    )
  }
  if (!res.check.ok) {
    return (
      <div data-testid="plg-sideload-errors" className="rounded-xl border border-err/30 bg-err-soft px-3.5 py-3">
        <div className="text-[13px] font-medium text-err">清单有 <span className="tabular-nums">{res.check.errors.length}</span> 处问题，改好再校验</div>
        <ul className="mt-1.5 list-disc space-y-1 pl-4 text-[12.5px] leading-relaxed text-err marker:text-err/60">{res.check.errors.map((e) => <li key={e}>{e}</li>)}</ul>
      </div>
    )
  }
  return <ManifestOk m={res.check.manifest} />
}

function ManifestOk({ m }: { m: PluginManifest }) {
  const { plugins, pluginCatalog } = useApp()
  const same = pluginCatalog.find((x) => x.id === m.id) ?? plugins.find((p) => p.id === m.id)?.manifest
  return (
    <div data-testid="plg-sideload-ok" className="rounded-xl border border-line px-3.5 py-3">
      <div className="flex items-center gap-3">
        <PluginIcon m={m} size={36} />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2"><span className="truncate text-[14px] font-semibold">{m.name}</span><span className="shrink-0 font-code text-[11.5px] text-fg-3">v{m.version}</span><CategoryTag c={m.category} /></div>
          <div className="truncate text-[12px] text-fg-2">{m.publisher} · {m.summary}</div>
        </div>
        <span className="inline-flex shrink-0 items-center gap-1 text-[12.5px] font-medium text-ok"><Check className="h-3.5 w-3.5" />清单校验通过</span>
      </div>
      {same && <p className="mt-2 text-[12.5px] text-warm">已经有同 id 的插件「{same.name}」v{same.version}，装这份会当成它的另一个版本。</p>}
      <div className="mt-2.5 flex flex-wrap gap-1.5">
        {m.permissions.map((p) => <span key={p.scope} className="inline-flex items-center gap-1.5 rounded-lg border border-line py-0.5 pl-2 pr-1 text-[12px] text-fg-2">{p.detail}<RiskBadge r={p.risk} /></span>)}
        {m.contributes.commands.map((c) => <CommandTag key={c.name}>/{c.name}</CommandTag>)}
      </div>
      <p data-testid="plg-sideload-backend" className="mt-3 rounded-lg bg-hover px-3 py-2 text-[12.5px] leading-relaxed text-fg-2">{COPY.sideloadNeedBackend}</p>
    </div>
  )
}
