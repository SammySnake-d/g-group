// 工件回传(U45、验收 AC-04):联系人交付时,把 Compute 本次产出的可读工件(.md 文档、文本、表格、图片、PDF)
// 按内容 sha256 快照进宿主数据目录 artifacts/<sha256><扩展名>,同内容只存一份;交付卡片引用 ref + sha256,
// 之后工作区里的文件再改,卡片仍指向交付时的那份快照。代码文件不进卡片(群里不便全量看,U45)。
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { type Db, one, run } from "./db.ts";

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

export const isReadable = (file: string) => Object.hasOwn(READABLE_MIME, path.extname(file).toLowerCase());

export class ArtifactStore {
  private readonly db: Db;
  readonly dir: string;
  private readonly now: () => string;
  constructor(db: Db, dir: string, now: () => string) {
    this.db = db;
    this.dir = dir;
    this.now = now;
  }
  /** 存一份快照:按内容 hash 命名,已存在就不再写;同一 ref 只登记一次。 */
  put(name: string, data: Buffer): ArtifactRef {
    const ext = path.extname(name).toLowerCase();
    const sha256 = createHash("sha256").update(data).digest("hex");
    const ref = `art-${sha256.slice(0, 32)}${ext}`;
    const mime = READABLE_MIME[ext] ?? "application/octet-stream";
    const file = path.join(this.dir, `${sha256}${ext}`);
    mkdirSync(this.dir, { recursive: true });
    if (!existsSync(file)) {
      // 先写临时文件再改名:半截文件不会被当成快照
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, data);
      renameSync(tmp, file);
    }
    // 名字用工作目录里的相对路径(统一成 /),同名不同目录的工件能分清
    const shown = name.split(path.sep).join("/").slice(-500);
    run(this.db, "INSERT OR IGNORE INTO gg_artifacts (ref, sha256, name, mime, bytes, path, added_at) VALUES (?, ?, ?, ?, ?, ?, ?)", ref, sha256, shown, mime, data.length, file, this.now());
    return { ref, name: shown, mime, bytes: data.length, sha256 };
  }
  get(ref: string): (ArtifactRef & { readonly path: string }) | undefined {
    return one<{ ref: string; sha256: string; name: string; mime: string; bytes: number; path: string }>(this.db, "SELECT ref, sha256, name, mime, bytes, path FROM gg_artifacts WHERE ref = ?", ref);
  }
  /** 读快照;内容 hash 与登记的不一致(被改过)就拒绝,不把别的版本当成这张卡片的内容 */
  read(ref: string): { meta: ArtifactRef & { readonly path: string }; data: Buffer } | undefined {
    const meta = this.get(ref);
    if (!meta || !existsSync(meta.path)) return undefined;
    const data = readFileSync(meta.path);
    if (createHash("sha256").update(data).digest("hex") !== meta.sha256) throw new Error(`工件 ${ref} 的快照内容与登记的 sha256 不一致`);
    return { meta, data };
  }
}

/**
 * 没有 git 工作树时的退路:在 Compute 工作目录里找本任务 Compute 启动之后改过的可读文件。
 * 局限:按修改时间判断,工作目录若被别的任务或进程同时写,会把它们的文件也收进来;跳过隐藏目录与 node_modules,最多 6 层。
 */
export function recentReadable(root: string, sinceMs: number, limit = MAX_ARTIFACTS): string[] {
  const out: { rel: string; mtime: number }[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 6) return;
    let names: string[];
    try {
      names = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const n of names) {
      if (n.startsWith(".") || n === "node_modules") continue;
      const abs = path.join(dir, n);
      const st = lstatSync(abs);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) walk(abs, depth + 1);
      else if (st.isFile() && isReadable(n) && st.mtimeMs >= sinceMs && st.size <= MAX_ARTIFACT_BYTES) out.push({ rel: path.relative(root, abs), mtime: st.mtimeMs });
    }
  };
  if (existsSync(root) && statSync(root).isDirectory()) walk(root, 0);
  return out.slice(0, limit).map((x) => x.rel);
}
