// 共享文档单一提交点(AC-21,需求文档 D20.1(3) 路径 A、4B R-Doc、C-US11):
//   - 所有写入只经这一个服务;权威正文与版本在 SQLite 同一个写事务里(adapter-sqlite docs 表的 CAS + 本文件的版本链与请求表);
//   - 提交带 (docId, baseVersion, content, requestId):基线版本等于当前版本 → 推进到 v+1;版本变了 → conflict(带 currentVer),什么都不写;
//   - 同一 requestId 重试(提交点已成功、回执丢了)→ 直接返回当时生效的版本,不重复写;同一 requestId 换了内容 → 拒绝;
//   - 工作区里的 <dataDir>/shared-docs/<id>.md 只是提交后的派生镜像:写镜像失败不回滚提交点;读取和宿主启动时
//     发现镜像与权威版本不一致(缺失、迟到的旧内容覆盖)就按权威版本重写(V19-02)。
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { SharedDocVersionView, SharedDocView } from "@g-group/api-contract";
import { type Db, HostError, all, getDoc, listDocs, one, putDoc, run, tx } from "./db.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS gg_doc_versions (
  doc_id TEXT NOT NULL, ver INTEGER NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL, by_kind TEXT NOT NULL, by_id TEXT NOT NULL,
  at TEXT NOT NULL, request_id TEXT NOT NULL, PRIMARY KEY (doc_id, ver)
);
CREATE TABLE IF NOT EXISTS gg_doc_requests (request_id TEXT PRIMARY KEY, doc_id TEXT NOT NULL, ver INTEGER NOT NULL, fingerprint TEXT NOT NULL);
`;

export type DocMember = { kind: "user" | "contact"; id: string };
interface DocBody {
  readonly id: string;
  readonly roomId: string | null;
  readonly title: string;
  readonly content: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly updatedBy: DocMember;
}
export interface CommitInput {
  readonly docId: string;
  readonly baseVersion: number;
  readonly content: string;
  readonly requestId: string;
  readonly title?: string;
}
export interface CommitOutcome {
  /** 提交之后的权威版本(重放时也是当前最新) */
  readonly doc: SharedDocView;
  /** 这次请求生效的版本号;重放时是当初生效的那一版 */
  readonly committedVersion: number;
  /** true:同一 requestId 已经提交过,这次什么都没写 */
  readonly replayed: boolean;
}

export interface SharedDocsDeps {
  readonly db: Db;
  readonly dataDir: string;
  readonly now: () => string;
  readonly newId: (prefix: string) => string;
  /** 会话存在性校验;不存在抛 not_found */
  readonly checkRoom: (roomId: string) => void;
  readonly emit: (doc: SharedDocView) => void;
  readonly onReport?: (what: string, detail: unknown) => void;
}

const KEY = (id: string) => `shared:${id}`;
/** 另一个连接(可能是另一个进程)持有写锁超过 busy 超时:什么都没写,调用方重读版本后再决定是否重交 */
const isBusy = (e: unknown) => {
  const code = (e as { errcode?: unknown } | null)?.errcode;
  return typeof code === "number" && (code & 0xff) === 5;
};
function writeTx(db: Db, fn: () => void) {
  try {
    tx(db, fn);
  } catch (e) {
    if (isBusy(e)) throw new HostError("unavailable", "共享文档正被另一处写入,请重读后再提交", { reason: "busy" });
    throw e;
  }
}
const fingerprint = (x: unknown) => createHash("sha256").update(JSON.stringify(x)).digest("hex");

export class SharedDocs {
  private readonly d: SharedDocsDeps;
  constructor(d: SharedDocsDeps) {
    this.d = d;
    d.db.store.db.exec(SCHEMA);
  }

  private view(body: DocBody, ver: number): SharedDocView {
    return { id: body.id, roomId: body.roomId, title: body.title, content: body.content, version: ver, createdAt: body.createdAt, updatedAt: body.updatedAt, updatedBy: body.updatedBy };
  }
  private authoritative(docId: string): { value: DocBody; ver: number } {
    const d = getDoc<DocBody>(this.d.db, KEY(docId));
    if (!d) throw new HostError("not_found", `没有共享文档 ${docId}`);
    return d;
  }

  /** 派生镜像路径:id 只含安全字符时用它本身,否则用 hash,保证落在 <dataDir>/shared-docs/ 里 */
  mirrorPath(docId: string): string {
    const name = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/.test(docId) ? docId : createHash("sha256").update(docId).digest("hex");
    return path.join(this.d.dataDir, "shared-docs", `${name}.md`);
  }
  /** 镜像与权威正文不一致就按权威重写;返回是否修复过。写失败只报告,不影响提交点 */
  private syncMirror(docId: string, content: string): boolean {
    const f = this.mirrorPath(docId);
    try {
      if (existsSync(f) && readFileSync(f, "utf8") === content) return false;
      mkdirSync(path.dirname(f), { recursive: true });
      const tmp = `${f}.${process.pid}.tmp`;
      writeFileSync(tmp, content);
      renameSync(tmp, f);
      return true;
    } catch (e) {
      this.d.onReport?.("shared-doc-mirror", { docId, error: e instanceof Error ? e.message : String(e) });
      return false;
    }
  }
  /** 启动时按权威版本修复全部镜像;返回修复了几份 */
  repairMirrors(): number {
    let n = 0;
    for (const d of listDocs<DocBody>(this.d.db, "shared:")) if (this.syncMirror(d.value.id, d.value.content)) n++;
    return n;
  }

  create(input: { clientActionId: string; title: string; content: string; roomId?: string | null }, by: DocMember): SharedDocView {
    const roomId = input.roomId ?? null;
    if (roomId) this.d.checkRoom(roomId);
    const fp = fingerprint({ create: true, title: input.title, content: input.content, roomId });
    const reqId = `create:${input.clientActionId}`;
    let out: { body: DocBody; ver: number } | null = null;
    let replay = false;
    writeTx(this.d.db, () => {
      const prior = one<{ doc_id: string; ver: number; fingerprint: string }>(this.d.db, "SELECT doc_id, ver, fingerprint FROM gg_doc_requests WHERE request_id = ?", reqId);
      if (prior) {
        if (prior.fingerprint !== fp) throw new HostError("conflict", `clientActionId ${input.clientActionId} 已用于另一次新建`, { docId: prior.doc_id });
        const cur = this.authoritative(prior.doc_id);
        out = { body: cur.value, ver: cur.ver };
        replay = true;
        return;
      }
      const id = this.d.newId("d");
      const at = this.d.now();
      const body: DocBody = { id, roomId, title: input.title, content: input.content, createdAt: at, updatedAt: at, updatedBy: by };
      const ver = putDoc(this.d.db, KEY(id), 0, body);
      run(this.d.db, "INSERT INTO gg_doc_versions (doc_id, ver, title, content, by_kind, by_id, at, request_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", id, ver, body.title, body.content, by.kind, by.id, at, reqId);
      run(this.d.db, "INSERT INTO gg_doc_requests (request_id, doc_id, ver, fingerprint) VALUES (?, ?, ?, ?)", reqId, id, ver, fp);
      out = { body, ver };
    });
    const r = out as unknown as { body: DocBody; ver: number };
    const view = this.view(r.body, r.ver);
    this.syncMirror(view.id, r.body.content);
    if (!replay) this.d.emit(view);
    return view;
  }

  /** 唯一提交点:版本校验、正文、版本链、幂等键在同一个写事务里 */
  commit(input: CommitInput, by: DocMember): CommitOutcome {
    const fp = fingerprint({ docId: input.docId, baseVersion: input.baseVersion, content: input.content, title: input.title ?? null });
    let committed = 0;
    let replayed = false;
    writeTx(this.d.db, () => {
      const prior = one<{ doc_id: string; ver: number; fingerprint: string }>(this.d.db, "SELECT doc_id, ver, fingerprint FROM gg_doc_requests WHERE request_id = ?", input.requestId);
      if (prior) {
        // 指纹里含 docId:同一 requestId 换文档或换内容都对不上
        if (prior.fingerprint !== fp) throw new HostError("conflict", `requestId ${input.requestId} 已用于另一次提交`, { docId: prior.doc_id, version: prior.ver });
        committed = prior.ver;
        replayed = true;
        return;
      }
      const cur = this.authoritative(input.docId);
      const at = this.d.now();
      const body: DocBody = { ...cur.value, title: input.title ?? cur.value.title, content: input.content, updatedAt: at, updatedBy: by };
      // CAS:期望版本就是调用方读到的 baseVersion,不是这里刚读到的当前版本;不一致 putDoc 抛 conflict(带 currentVer),整个事务回滚
      committed = putDoc(this.d.db, KEY(input.docId), input.baseVersion, body);
      run(this.d.db, "INSERT INTO gg_doc_versions (doc_id, ver, title, content, by_kind, by_id, at, request_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", input.docId, committed, body.title, body.content, by.kind, by.id, at, input.requestId);
      run(this.d.db, "INSERT INTO gg_doc_requests (request_id, doc_id, ver, fingerprint) VALUES (?, ?, ?, ?)", input.requestId, input.docId, committed, fp);
    });
    const cur = this.authoritative(input.docId);
    const doc = this.view(cur.value, cur.ver);
    this.syncMirror(doc.id, cur.value.content);
    if (!replayed) this.d.emit(doc);
    return { doc, committedVersion: committed, replayed };
  }

  /** 读权威版本;顺带按权威修复镜像。version 给了就读版本链里的那一版 */
  get(docId: string, version?: number): SharedDocView {
    const cur = this.authoritative(docId);
    this.syncMirror(docId, cur.value.content);
    if (version === undefined || version === cur.ver) return this.view(cur.value, cur.ver);
    const v = one<{ ver: number; title: string; content: string; by_kind: DocMember["kind"]; by_id: string; at: string }>(this.d.db, "SELECT * FROM gg_doc_versions WHERE doc_id = ? AND ver = ?", docId, version);
    if (!v) throw new HostError("not_found", `共享文档 ${docId} 没有第 ${version} 版`);
    return { ...this.view(cur.value, v.ver), title: v.title, content: v.content, updatedAt: v.at, updatedBy: { kind: v.by_kind, id: v.by_id } };
  }
  list(q: { roomId?: string }): SharedDocView[] {
    return listDocs<DocBody>(this.d.db, "shared:")
      .filter((d) => q.roomId === undefined || d.value.roomId === q.roomId)
      .map((d) => this.view(d.value, d.ver))
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : a.id < b.id ? -1 : 1));
  }
  /** 版本链,从新到旧 */
  history(docId: string, limit = 50): SharedDocVersionView[] {
    this.authoritative(docId);
    return all<{ ver: number; title: string; content: string; by_kind: DocMember["kind"]; by_id: string; at: string; request_id: string }>(
      this.d.db,
      "SELECT * FROM gg_doc_versions WHERE doc_id = ? ORDER BY ver DESC LIMIT ?",
      docId,
      limit,
    ).map((v) => ({ version: v.ver, title: v.title, updatedBy: { kind: v.by_kind, id: v.by_id }, at: v.at, bytes: Buffer.byteLength(v.content), requestId: v.request_id }));
  }
}
