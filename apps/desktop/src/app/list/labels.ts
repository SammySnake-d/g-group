import type { Artifact } from '@/data'

/** 文件区的分组顺序和名字 */
export const FILE_KINDS: { kind: Artifact['kind']; label: string }[] = [
  { kind: 'page', label: '网页' },
  { kind: 'doc', label: '文档' },
  { kind: 'sheet', label: '清单' },
  { kind: 'asset', label: '资产' },
]
