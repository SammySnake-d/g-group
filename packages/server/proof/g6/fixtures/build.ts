// 测试用的原始记录与题目构造器(只造数据,不含被测逻辑)。放在 fixtures/ 下,门禁不把它当被测源码。
import type { CallRecord, FixtureItem, FixtureSet, RawRecord } from "../types.ts";

export const A = { key: "A", name: "小甲", persona: "你叫小甲,负责日程与会议安排。", marker: "负责日程与会议安排" } as const;
export const B = { key: "B", name: "小乙", persona: "你叫小乙,负责报销与采购。", marker: "负责报销与采购" } as const;

export function mkItem(over: Partial<FixtureItem> = {}): FixtureItem {
  return {
    id: "T",
    title: "测试题",
    contacts: [A],
    rooms: [{ key: "dm", kind: "dm", contacts: ["A"] }],
    steps: [
      { op: "send", room: "dm", text: "以后周报都发到 weekly@corp.example" },
      { op: "filler", room: "dm", count: 1 },
      { op: "send", room: "dm", text: "周报要发到哪个邮箱来着?", probe: "P1" },
    ],
    probes: [{ id: "P1", step: 2, category: "untagged-detail", expect: "weekly@corp\\.example", reject: null, needs: "weekly@corp.example", misled: null, standin: { answer: "发到 weekly@corp.example。" } }],
    memories: { expect: [{ id: "M1", contact: "A", match: "weekly@corp", scope: "global", sourceStep: 0 }], forbid: [{ id: "W1", contact: "A", match: "英文", scope: "global" }] },
    forbidden: [],
    faults: [],
    ...over,
  };
}
export function mkSet(items: FixtureItem[] = [mkItem()]): FixtureSet {
  return { schema: "g6-fixtures/v1", id: "test-set", note: "测试", fillers: ["今天食堂的番茄炒蛋有点咸", "楼下咖啡店换了新的菜单"], items };
}

let n = 0;
/** 宿主呈现格式的一条用户消息(检查材料与第 4 块里的样子) */
export const line = (seq: number, text: string, room = "dm-1") => `#${seq} · ${room} · 我(user:me) · 2026-11-11T00:00:00.000Z\n${text}\n`;
export const roundRequest = (o: { note?: string; fresh?: string; pointers?: string }) =>
  `<block n="2" label="承诺账本">\n(无)\n</block>\n<block n="3" label="状态笔记">\n${o.note ?? "(尚无)"}\n</block>\n<block n="4" label="新消息">\n${o.fresh ?? ""}\n</block>\n<block n="5" label="指针与按需换入">\n${o.pointers ?? "(无)"}\n</block>`;
export const checkRequest = (material: string, note = "(没有旧笔记)") => `[联系人人设与职责]\n${A.persona}\n\n[旧状态笔记]\n${note}\n\n[本轮新输入(原文)]\n${material}[联系人本轮动作]\n(无)\n`;

export function mkCall(over: Partial<CallRecord> = {}): CallRecord {
  n++;
  return { n, at: 1000 + n, ms: 10, contact: "A", cls: "round", model: "m", maxTokens: 4096, status: 200, outcome: "ok", stopReason: "end_turn", usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 }, tools: [], text: "", system: `你叫小甲。${A.marker}`, request: roundRequest({}), fault: null, ...over };
}

/** 一份按 mkItem() 跑完的记录:三条消息都发出去了,检查都成功,记忆写对了,追问答对了。 */
export function mkRecord(over: Partial<RawRecord> = {}): RawRecord {
  return {
    schema: "g6-raw/v1",
    runId: "g1/m/T/1",
    group: "g1",
    commit: "c",
    mode: "standin",
    model: "m",
    item: "T",
    rep: 1,
    fingerprint: "fp",
    startedAt: 1000,
    endedAt: 5000,
    status: "ok",
    error: null,
    roomIds: { dm: "dm-1" },
    contactIds: { A: "c-1" },
    steps: [
      { step: 0, op: "send", startedAt: 1000, settledAt: 1100, timedOut: false },
      { step: 1, op: "filler", startedAt: 1200, settledAt: 1300, timedOut: false },
      { step: 2, op: "send", startedAt: 1400, settledAt: 1500, timedOut: false },
    ],
    sent: [
      { step: 0, index: 0, room: "dm", roomId: "dm-1", seq: 1, text: "以后周报都发到 weekly@corp.example", at: 1000 },
      { step: 1, index: 0, room: "dm", roomId: "dm-1", seq: 3, text: "今天食堂的番茄炒蛋有点咸", at: 1200 },
      { step: 2, index: 0, room: "dm", roomId: "dm-1", seq: 5, text: "周报要发到哪个邮箱来着?", at: 1400 },
    ],
    ops: [
      { order: 1, op: "send", room: "dm", seq: 1, step: 0, at: 1000 },
      { order: 2, op: "send", room: "dm", seq: 3, step: 1, at: 1200 },
      { order: 3, op: "send", room: "dm", seq: 5, step: 2, at: 1400 },
    ],
    replies: [
      { room: "dm", seq: 2, contact: "A", text: "收到", at: 1050 },
      { room: "dm", seq: 4, contact: "A", text: "嗯嗯", at: 1250 },
      { room: "dm", seq: 6, contact: "A", text: "发到 weekly@corp.example。", at: 1450 },
    ],
    memories: { A: [{ id: "m1", status: "active", title: "周报邮箱", body: "以后周报都发到 weekly@corp.example", anchors: ["global"], source: { roomId: "dm-1", seq: 1 } }] },
    notes: { A: "- 周报邮箱" },
    reports: [],
    hostDebt: null,
    calls: [
      mkCall({ at: 1010, request: roundRequest({ fresh: line(1, "以后周报都发到 weekly@corp.example") }) }),
      mkCall({ at: 1020, cls: "check", request: checkRequest(line(1, "以后周报都发到 weekly@corp.example")), system: '只输出 JSON {"memories": []}' }),
      mkCall({ at: 1210, request: roundRequest({ fresh: line(3, "今天食堂的番茄炒蛋有点咸") }) }),
      mkCall({ at: 1220, cls: "check", request: checkRequest(line(3, "今天食堂的番茄炒蛋有点咸")), system: '只输出 JSON {"memories": []}' }),
      mkCall({ at: 1410, request: roundRequest({ fresh: line(5, "周报要发到哪个邮箱来着?"), pointers: "记忆 m1 · 周报邮箱 原文:以后周报都发到 weekly@corp.example" }) }),
      mkCall({ at: 1420, cls: "check", request: checkRequest(line(5, "周报要发到哪个邮箱来着?")), system: '只输出 JSON {"memories": []}' }),
    ],
    ...over,
  };
}
