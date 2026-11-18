// 记忆与状态笔记的撤回 / 回退清洗(验收 AC-08 记忆与笔记侧、AC-42 ⑤⑧;需求 U29、D06 §1、D25 §4)。新逻辑都在这里,宿主只在几个点调用:
//   ① 来源已撤回的记忆:条目的来源消息被撤回(含群主删除;本端隐藏不算),而且复述佐证里也没有还在的消息,
//      就对联系人不可见——不进第 1 块前缀、不进第 5 块、read_memory 读不到、写入判关系时也不当邻域;条目本身留在 md 与索引里,
//      用户经 memory.list / get 能看到「来源已撤回」,也能撤销它。是否可见每次按撤回事件现算,不另存标记。
//      做法是 HygienicMemoryStore.list() 只返回可见条目,宿主所有读路径(含 MemoryStore.get)自动受约束;给用户看的走 listAll()。
//   ② 前缀快照:memprefix:<联系人> 里存着上次并入前缀的全局条目正文,来源撤回的条目要从快照里拿掉(撤回优先于前缀不变,AC-08)。
//   ③ 回退清洗(U29 候选:私聊工作记忆 = 该联系人的状态笔记,存放方式用户未定):rewind 撤下范围里的消息原文(含编辑稿)
//      并进状态笔记的清洗集合,与撤回同一套 scrubRetracted,不另建版本化笔记;还出现在仍有效消息里的原文不算(回退后常重发同一句)。
//      长期记忆不随 rewind 改变。
//   ④ 启动核对(AC-42 ⑧ 的生产入口):每个有 md 目录的联系人,按「全部条目的 md 序列化」哈希比对 md 真源与 gg_memory 索引,
//      索引缺失或与 md 不一致就从 md 重建。
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadLog } from "@g-group/adapter-sqlite";
import { project } from "@g-group/domain";
import { type MemoryEntry, parseMemory, serializeMemory, squash } from "@g-group/kernel";
import { type Db, all, getDoc, putDoc } from "./db.ts";
import { MemoryStore } from "./memory-store.ts";
import { inRanges, rewindRanges } from "./rewind.ts";

const SAFE = /^[A-Za-z0-9._-]+$/;

/** 一个会话里被撤回的消息 seq(撤回事件只追加,群主删除也走撤回)。 */
function retractedSeqs(db: Db, roomId: string) { throw new Error("P1-A compile-only stub"); }

export class HygienicMemoryStore extends MemoryStore {
  private readonly hdb: Db;
  private readonly mdRoot: string;
  private readonly note: (what: string, detail: unknown) => void;
  readonly now: () => string;
  constructor(db: Db, root: string, report: (what: string, detail: unknown) => void, now: () => string) {
    super(db, root, report);
    this.hdb = db;
    this.mdRoot = root;
    this.note = report;
    this.now = now;
    this.checkIndex();
  }
  /** 这些条目里对联系人不可见的条目 id:来源消息已撤回,而且复述佐证里也没有还在的消息。 */
  hiddenIds(entries: readonly MemoryEntry[]) { throw new Error("P1-A compile-only stub"); }
  /** 全部条目(给用户本人看、给 memory.* 改),含来源已撤回的。 */
  listAll(contactId: string): MemoryEntry[] { throw new Error("P1-A compile-only stub"); }
  /** 联系人可见的条目:宿主每条读路径(装配、read_memory、判关系邻域、压缩检查邻域、get)都经这里。 */
  override list(contactId: string): MemoryEntry[] { throw new Error("P1-A compile-only stub"); }
  private digest(entries: readonly MemoryEntry[]) { throw new Error("P1-A compile-only stub"); }
  /** 启动核对:md 真源与索引按条目哈希比对,不一致(含索引表被删、条目缺失、md 被改)就从 md 重建该联系人 */
  checkIndex() { throw new Error("P1-A compile-only stub"); }
}

/** 前缀快照里拿掉对联系人已不可见的条目(来源撤回优先于前缀不变);拿掉的不写「已不再适用」行,标题也不再出现。 */
export function purgeHiddenPrefix(db: Db, contactId: string, store: HygienicMemoryStore): void { throw new Error("P1-A compile-only stub"); }

/** 这些会话里被 rewind 撤下的消息原文(含编辑稿);仍出现在某条有效消息里的不算,免得误清用户回退后重发的同一句话。 */
export function rewoundTexts(db: Db, roomIds: readonly string[]): string[] { throw new Error("P1-A compile-only stub"); }

/** 立刻按当前清洗集合重洗这些联系人已落盘的状态笔记(rewind 事务里调用,资料页与下一轮第 3 块都不再有撤下原文)。 */
export function rescrubNotes(db: Db, contactIds: readonly string[], scrub: (contactId: string, text: string) => string): void { throw new Error("P1-A compile-only stub"); }
