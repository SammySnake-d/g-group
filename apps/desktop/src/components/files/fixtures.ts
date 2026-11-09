import type { Artifact } from '@/data'

// 只由开发/设计导出模式启用的同形数据边界，不改 DOM 或 CSS 来伪造极端状态。
const cases = new Map<string, Artifact[]>()
export function fileDataset(mode: string | null, original: Artifact[]): Artifact[] {
  if (!mode) return original
  const cached = cases.get(mode)
  if (cached) return cached
  let result = original
  if (mode === 'empty') result = []
  if (mode === 'one') result = original.slice(0, 1)
  if (mode === 'worst') result = original.map((a, i) => ({ ...a, name: [
    'Q3 Board Deck — FINAL (revised) v12 [approved by legal].pdf',
    'IMG_20250914_183022_HDR_portrait_edited_edited.HEIC',
    '多模型协作产品跨端交互与信息架构调整清单（十一月审阅版）',
    '香港服务器生产环境部署与灾难恢复记录',
    '群协作手册',
  ][i] ?? a.name }))
  if (mode === 'many') result = Array.from({ length: 1200 }, (_, i) => ({ ...original[i % original.length], id: `volume-${i}`, name: `交互对照-${i + 1}.md` }))
  cases.set(mode, result)
  return result
}
