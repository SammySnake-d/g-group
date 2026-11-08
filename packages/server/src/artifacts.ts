// 工件回传(U45、验收 AC-04):联系人交付时,把 Compute 本次产出的可读工件(.md 文档、文本、表格、图片、PDF)
// 按内容 sha256 快照进宿主数据目录 artifacts/<sha256><扩展名>,同内容只存一份;交付卡片引用 ref + sha256,
// 之后工作区里的文件再改,卡片仍指向交付时的那份快照。代码文件不进卡片(群里不便全量看,U45)。
import type { Db } from "./db.ts";

export interface ArtifactRef {
  readonly ref: string;
  readonly name: string;
  readonly mime: string;
  readonly bytes: number;
  readonly sha256: string;
}

export const READABLE_MIME: Readonly<Record<string, string>> = Object.freeze({
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".html": "text/html",
  ".htm": "text/html",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
});
/** 单个工件上限与一次交付最多收几个 */
export const MAX_ARTIFACT_BYTES = 10 * 1024 * 1024;
export const MAX_ARTIFACTS = 20;
/** artifacts.get 直接带回正文的上限(文本类) */
export const MAX_INLINE_TEXT = 1024 * 1024;

export const isReadable = (_file: string) => false;

export class ArtifactStore {
  readonly dir: string;
  constructor(_db: Db, dir: string, _now: () => string) {
    this.dir = dir;
  }
  put(_name: string, _data: Buffer): ArtifactRef {
    throw new Error("未实现");
  }
  get(_ref: string): (ArtifactRef & { readonly path: string }) | undefined {
    throw new Error("未实现");
  }
  read(_ref: string): { meta: ArtifactRef & { readonly path: string }; data: Buffer } | undefined {
    throw new Error("未实现");
  }
}

export function recentReadable(_root: string, _sinceMs: number, _limit = MAX_ARTIFACTS): string[] {
  throw new Error("未实现");
}
