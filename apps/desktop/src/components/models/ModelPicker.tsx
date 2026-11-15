import { Selector } from '@astryxdesign/core'
import type { ModelSettings } from '@/modelConfig'

export function ModelPicker({ s, value, label, testid, onChange, compute = false, invalid = false }: { s: ModelSettings; value: string; label: string; testid: string; onChange: (id: string) => void; compute?: boolean; invalid?: boolean }) {
  const off = s.catalog?.state === 'error' || !!(compute && s.catalog && !s.catalog.computeCapabilities)
  const reason = s.catalog?.state === 'error' ? s.catalog.reason : compute && s.catalog && !s.catalog.computeCapabilities ? '网关未声明 Compute Harness 兼容能力，保留当前设置。' : undefined
  const models = s.models.some((m) => m.id === value) || !value ? s.models : [...s.models, { id: value, label: value, harnesses: [], vendor: 'unknown' }]
  return <span className="block w-[230px] max-w-full">
    <Selector data-testid={testid} label={label} isLabelHidden value={value} onChange={onChange} options={models.map((m) => ({ value: m.id, label: m.label }))} hasSearch searchPlaceholder="搜索模型 ID" emptySearchText="没有这个模型" isDisabled={off} disabledMessage={reason} status={invalid ? { type: 'error' } : undefined} size="sm" width="100%" />
  </span>
}
