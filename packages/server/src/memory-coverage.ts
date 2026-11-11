// G1：检查覆盖与 md 写入意图不是第三份摘要，不进入模型请求；沿用 docs/CAS 与原重试策略。
import { decideRetry, type MemoryEntry, type RetryPolicy, type HealClass } from "@g-group/kernel";
import { type Db, getDoc, putDoc, listDocs, tx } from "./db.ts";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { MemoryStore } from "./memory-store.ts";
export interface CoverageRef { roomId: string; seq: number; revision: number }
export interface CaptureWrite {
  id: string;
  before: readonly (MemoryEntry | null)[];
  after: readonly MemoryEntry[];
  question: { roomId: string; text: string } | null;
}
export interface CoverageWork {
  id: string; contactId: string; sources: readonly CoverageRef[]; inboxIds: readonly number[]; rooms: readonly string[];
  state: "pending" | "failed" | "ok"; attempts: number; retryAt: number | null; blocked: boolean; error: string | null;
  writes: readonly CaptureWrite[] | null; writesDone: boolean; unresolved: number;
  disposition: string | null; upstream: string; alerted: boolean; failureHeal?: HealClass;
  /** G5:本批转成待精筛标记的条数(标记完成不等于记忆已写) */
  marks?: number;
  /** G5 切换时接管的 G1 待复查项;handedOver 只在新出口(直接写计划与标记)和接管关系同一事务落盘后才置 */
  takeover?: boolean; handedOver?: boolean;
  /** 接管时 G1 已落地候选的来源键(来源 + 原话或正文),之后不再为它们生成标记 */
  landed?: string[];
  /** G5 精筛批次借用同一写入计划/恢复协议;不是消息覆盖,不进补查 */
  purpose?: "refine";
}
const key = (id: string) => `memory-coverage:${id}`;
export class MemoryCoverage {
  readonly db: Db; readonly memory: MemoryStore;
  constructor(db: Db, memory: MemoryStore) { this.db = db; this.memory = memory; }
  private set(id: string, change: Partial<CoverageWork>): CoverageWork {
    const doc = getDoc<CoverageWork>(this.db, key(id));
    if (!doc) throw new Error(`没有覆盖工作 ${id}`);
    const next = { ...doc.value, ...change }; putDoc(this.db, key(id), doc.ver, next); return next;
  }
  begin(contactId: string, sources: readonly CoverageRef[], inboxIds: readonly number[], rooms: readonly string[], upstream: string): CoverageWork {
    const refs = [...sources].sort((a,b) => a.roomId.localeCompare(b.roomId) || a.seq-b.seq || a.revision-b.revision);
    const ids = [...inboxIds].sort((a,b)=>a-b); const rs=[...new Set(rooms)].sort();
    const id = createHash("sha256").update(JSON.stringify([contactId,refs,ids,rs])).digest("hex");
    const old = getDoc<CoverageWork>(this.db,key(id)); if(old) return old.value;
    const work: CoverageWork = { id,contactId,sources:refs,inboxIds:ids,rooms:rs,state:"pending",attempts:0,retryAt:0,blocked:false,error:null,writes:null,writesDone:false,unresolved:0,disposition:null,upstream,alerted:false };
    putDoc(this.db,key(id),0,work);return work;
  }
  /** G5 精筛一批的写入工作:身份由联系人与批次决定,与消息覆盖分开;写入计划/恢复照 G1 原路径 */
  beginRefine(contactId: string, batchId: string, sources: readonly CoverageRef[], rooms: readonly string[], upstream: string): CoverageWork {
    const id = `refine-${createHash("sha256").update(JSON.stringify([contactId,batchId])).digest("hex")}`;
    const old = getDoc<CoverageWork>(this.db,key(id)); if(old) return old.value;
    const work: CoverageWork = { id,contactId,sources:[...sources],inboxIds:[],rooms:[...new Set(rooms)].sort(),state:"pending",attempts:0,retryAt:null,blocked:true,error:null,writes:null,writesDone:false,unresolved:0,disposition:null,upstream,alerted:true,purpose:"refine" };
    putDoc(this.db,key(id),0,work);return work;
  }
  /** G5 在调用方事务里补记标记数与接管关系 */
  annotate(id: string, change: Pick<CoverageWork, "marks" | "takeover" | "handedOver" | "landed">): void { this.set(id, change); }
  get(id: string): CoverageWork { const doc=getDoc<CoverageWork>(this.db,key(id));if(!doc)throw new Error(`没有覆盖工作 ${id}`);return doc.value; }
  list(contactId?: string): CoverageWork[] { return listDocs<CoverageWork>(this.db,"memory-coverage:").map(d=>d.value).filter(w=>contactId===undefined||w.contactId===contactId); }
  start(id: string): void { this.set(id,{state:"pending",error:null,retryAt:0}); }
  prepare(id: string, writes: readonly CaptureWrite[], unresolved: number): void {
    if(this.dirty(this.get(id).contactId)) throw new Error("前一次记忆写入尚未恢复");
    this.set(id,{writes,writesDone:false,unresolved,state:"pending"});
  }
  apply(id: string, notify?: (q: { roomId: string; text: string }, actionId: string) => void): void {
    const work=this.get(id); if(work.writes===null||work.writesDone)return;
    // DB 回滚不撤掉已改名的 md；重试根据 md 的 captureIds 核对，不重新问模型/重算计划。
    tx(this.db,()=>{
      for(const write of work.writes!) {
        for(const [i,entry] of write.after.entries()) {
          const disk=this.memory.readDisk(work.contactId,entry.id);
          if(disk?.captureIds?.includes(write.id)) { this.memory.put(work.contactId,disk);continue; }
          if(!isDeepStrictEqual(disk,write.before[i]??null))throw new Error(`记忆 ${entry.id} 在写入期间被修改，不覆盖`);
          this.memory.put(work.contactId,entry);
        }
        if(write.question)notify?.(write.question,write.id);
      }
      this.set(id,{writesDone:true,state:work.unresolved ? "failed":"ok",retryAt:work.unresolved ? 0:null,error:work.unresolved?"部分候选仍待复查":null});
    });
  }
  invalidate(id: string, reason: string): void {
    const work=this.get(id);
    if(work.writes&&!work.writesDone)tx(this.db,()=>{
      for(const write of [...work.writes!].reverse())for(let i=write.after.length-1;i>=0;i--){
        const entry=write.after[i]!;const disk=this.memory.readDisk(work.contactId,entry.id);
        if(!disk?.captureIds?.includes(write.id))continue;
        if(!isDeepStrictEqual(disk,entry))throw new Error("来源失效但记忆已被后续修改，需要核对，不能覆盖");
        const previous=write.before[i];if(previous)this.memory.put(work.contactId,previous);else this.memory.remove(work.contactId,entry.id);
      }
    });
    this.set(id,{state:"failed",blocked:true,retryAt:null,disposition:reason,error:reason,writes:null,writesDone:true});
  }
  fail(id: string, error: string, heal: HealClass, policy: RetryPolicy, now: number, rand?: () => number): void {
    const w=this.get(id);const decision=decideRetry({heal,effect:"B0",attempts:w.attempts},policy,rand);
    this.set(id,{state:"failed",error:error.slice(0,4000),failureHeal:heal,attempts:decision.kind==="retry"?decision.attempt:w.attempts,retryAt:decision.kind==="retry"?now+decision.delayMs:null,blocked:decision.kind!=="retry"});
  }
  due(contactId: string, now: number): CoverageWork[] { return this.list(contactId).filter(w=>w.state!=="ok"&&!w.disposition&&!w.blocked&&(w.retryAt??0)<=now); }
  retry(id: string): void { if(this.get(id).disposition)return;this.set(id,{blocked:false,retryAt:0,attempts:0,alerted:false}); }
  unblock(upstream: string): void { for(const w of this.list())if(w.upstream===upstream&&w.failureHeal==="A2"&&!w.disposition&&w.state!=="ok")this.retry(w.id); }
  markAlerted(id: string): void { this.set(id,{alerted:true}); }
  dirty(contactId: string): boolean { return this.list(contactId).some(w=>w.writes!==null&&!w.writesDone); }
}
