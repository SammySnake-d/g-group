// 联系人记忆的存储(需求文档 D25 第 4 节):每条记忆一个 md 文件,是真源;SQLite 里的 gg_memory 是从 md 派生、可整表重建的索引。
// 目录:<dataDir>/memory/<联系人 id>/<记忆 id>.md。写入先写 md 再写索引;读取走索引;rebuild 删掉该联系人的索引后从 md 全量重建。
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { type MemoryEntry, parseMemory, serializeMemory } from "@g-group/kernel";
import { type Db, all, run } from "./db.ts";

const SAFE = /^[A-Za-z0-9._-]+$/;

export class MemoryStore {
  private readonly db: Db;
  private readonly root: string;
  private readonly report: (what: string, detail: unknown) => void;
  constructor(db: Db, root: string, report: (what: string, detail: unknown) => void) {
    this.db = db;
    this.root = root;
    this.report = report;
    run(db, "CREATE TABLE IF NOT EXISTS gg_memory (contact_id TEXT NOT NULL, id TEXT NOT NULL, created_at TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY (contact_id, id))");
  }
  private dir(contactId: string): string {
    if (!SAFE.test(contactId)) throw new Error(`联系人 id 不能用作目录名:${contactId}`);
    return join(this.root, contactId);
  }
  /** 该联系人的全部记忆,按创建时间、id 排序 */
  list(contactId: string): MemoryEntry[] {
    return all<{ json: string }>(this.db, "SELECT json FROM gg_memory WHERE contact_id = ? ORDER BY created_at, id", contactId).map((r) => JSON.parse(r.json) as MemoryEntry);
  }
  get(contactId: string, id: string): MemoryEntry | null {
    return this.list(contactId).find((e) => e.id === id) ?? null;
  }
  /** 写一条:md(先写临时文件再改名,不留半截文件)+ 索引 */
  put(contactId: string, e: MemoryEntry): void {
    if (!SAFE.test(e.id)) throw new Error(`记忆 id 不能用作文件名:${e.id}`);
    const d = this.dir(contactId);
    mkdirSync(d, { recursive: true });
    const file = join(d, `${e.id}.md`);
    writeFileSync(`${file}.tmp`, serializeMemory(e));
    renameSync(`${file}.tmp`, file);
    run(this.db, "INSERT INTO gg_memory (contact_id, id, created_at, json) VALUES (?, ?, ?, ?) ON CONFLICT (contact_id, id) DO UPDATE SET json = excluded.json, created_at = excluded.created_at", contactId, e.id, e.createdAt, JSON.stringify(e));
  }
  /** 原始 md 是恢复时的权威值；不是只看可能已回滚的 SQLite 索引。 */
  readDisk(contactId: string, id: string): MemoryEntry | null {
    if (!SAFE.test(id)) throw new Error("记忆 id 不合法");
    let text: string;
    try { text = readFileSync(join(this.dir(contactId), `${id}.md`), "utf8"); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
    const parsed = parseMemory(text);
    if (!parsed.ok) throw new Error(`记忆 md 损坏:${parsed.why}`);
    return parsed.entry;
  }
  remove(contactId: string, id: string): void {
    if (!SAFE.test(id)) throw new Error("记忆 id 不合法");
    try { unlinkSync(join(this.dir(contactId), `${id}.md`)); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    run(this.db, "DELETE FROM gg_memory WHERE contact_id = ? AND id = ?", contactId, id);
  }
  /** 删掉该联系人的索引,从 md 真源重建;解析不了的文件报告并跳过。返回重建的条数 */
  rebuild(contactId: string): number {
    run(this.db, "DELETE FROM gg_memory WHERE contact_id = ?", contactId);
    let files: string[];
    try {
      files = readdirSync(this.dir(contactId)).filter((f) => f.endsWith(".md"));
    } catch {
      return 0;
    }
    let n = 0;
    for (const f of files) {
      const r = parseMemory(readFileSync(join(this.dir(contactId), f), "utf8"));
      if (!r.ok) {
        this.report("memory-file-broken", { contactId, file: f, why: r.why });
        continue;
      }
      run(this.db, "INSERT INTO gg_memory (contact_id, id, created_at, json) VALUES (?, ?, ?, ?)", contactId, r.entry.id, r.entry.createdAt, JSON.stringify(r.entry));
      n++;
    }
    return n;
  }
}
