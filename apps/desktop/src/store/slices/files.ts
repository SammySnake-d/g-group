// 文件切片:连上后端时「文件」区列的会话文件(files.list 的附件与任务产出 + 交付消息带回的工件快照),由 api/wire/files.ts 写。
// 没连上后端时不用它,文件区照旧列演示数据(data.ts 的 artifacts);组件经 fileList() 取当前该列哪一份。
import { artifacts, type Artifact } from '@/data'
import type { Slice } from '../state'

export type FilesSlice = {
  /** 连上后端时读到的文件,按会话、出现顺序 */
  liveFiles: Artifact[]
  setLiveFiles: (list: Artifact[]) => void
}

export const createFilesSlice: Slice<FilesSlice> = (set) => ({
  liveFiles: [],
  setLiveFiles: (list) => set({ liveFiles: list }),
})

/** 文件区该列的文件:连上后端列后端的,没连上列演示的 */
export const fileList = (s: Pick<FilesSlice, 'liveFiles'> & { backend: { mode: string } }): Artifact[] => (s.backend.mode === 'connected' ? s.liveFiles : artifacts)
