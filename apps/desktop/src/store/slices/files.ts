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

export const fileList = (s: Pick<FilesSlice, 'liveFiles'> & { backend: { mode: string } }): Artifact[] => (s.backend.mode === 'connected' ? s.liveFiles : artifacts)
