/* 右侧分屏:实现拆在 components/split/ 下(骨架、Compute 工作视图、预览、画中画、文档冲突、产物)。
   这里只保留原来的公开名字,外部 import 不用改。 */
export { SplitPane } from './split/SplitPane'
export { Preview } from './split/Preview'
export { Pip } from './split/Pip'
export { Eye } from 'lucide-react'
export type { Compute } from '@/data'
