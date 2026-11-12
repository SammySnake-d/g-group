// G6 固定题集:校验、展开与冻结摘要。题集一旦冻结,摘要进清单;改一个字就是另一套题,不和旧结果比。
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { FixtureItem, FixtureSet, FixtureStep } from "./types.ts";

/** 键排序后的 JSON,同内容同串;摘要与配置指纹都用它。 */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map((x) => canonicalJson(x)).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
    .join(",")}}`;
}

export function fixtureDigest(set: FixtureSet): string {
  return createHash("sha256").update(canonicalJson(set)).digest("hex");
}

/** 一步实际发出的原文(filler 按题内出现顺序从公共填充句里轮流取,同一题内不重复)。edit/retract 不发新消息。 */
export function stepTexts(set: FixtureSet, item: FixtureItem, step: number): string[] {
  const s = item.steps[step];
  if (!s) return [];
  if (s.op === "send") return [s.text];
  if (s.op === "batch") return [...s.texts];
  if (s.op !== "filler") return [];
  let offset = 0;
  for (let i = 0; i < step; i++) {
    const p = item.steps[i];
    if (p?.op === "filler") offset += p.count;
  }
  const n = set.fillers.length;
  return Array.from({ length: s.count }, (_, k) => set.fillers[(offset + k) % n] ?? "");
}

const compiles = (src: string): boolean => {
  try {
    new RegExp(src, "i");
    return true;
  } catch {
    return false;
  }
};
const sendsTo = (s: FixtureStep | undefined): s is Extract<FixtureStep, { op: "send" | "batch" }> => s?.op === "send" || s?.op === "batch";

/** 题集自检:出问题返回逐条说明,空数组才算能跑。不改输入。 */
export function validateFixtureSet(set: FixtureSet): string[] {
  const out: string[] = [];
  if (set.schema !== "g6-fixtures/v1") out.push(`schema 应为 g6-fixtures/v1,实际 ${String(set.schema)}`);
  if (set.fillers.length === 0) out.push("fillers 为空");
  const ids = new Set<string>();
  for (const item of set.items) {
    const at = `题 ${item.id}`;
    if (ids.has(item.id)) out.push(`${at} 重复`);
    ids.add(item.id);
    const contacts = new Set<string>();
    const markers = new Set<string>();
    for (const c of item.contacts) {
      if (contacts.has(c.key)) out.push(`${at} 联系人 ${c.key} 重复`);
      contacts.add(c.key);
      if (!c.marker || !c.persona.includes(c.marker)) out.push(`${at} 联系人 ${c.key} 的人设里没有 marker`);
      if (markers.has(c.marker)) out.push(`${at} marker ${c.marker} 重复`);
      markers.add(c.marker);
    }
    const rooms = new Map(item.rooms.map((r) => [r.key, r]));
    for (const r of item.rooms) {
      if (r.kind === "dm" && r.contacts.length !== 1) out.push(`${at} 私聊 ${r.key} 必须正好一位联系人`);
      for (const k of r.contacts) if (!contacts.has(k)) out.push(`${at} 会话 ${r.key} 引用了不存在的联系人 ${k}`);
    }
    const seen = new Set<string>();
    item.steps.forEach((s, i) => {
      if (!rooms.has(s.room)) out.push(`${at} 第 ${i} 步的会话 ${s.room} 不存在`);
      if (s.op === "edit" || s.op === "retract") {
        const target = item.steps[s.step];
        if (s.step >= i || !sendsTo(target) || target.room !== s.room) out.push(`${at} 第 ${i} 步 ${s.op} 指向的第 ${s.step} 步不是同会话里更早发出的消息`);
        else if (target.op === "batch" && (s.index ?? 0) >= target.texts.length) out.push(`${at} 第 ${i} 步 ${s.op} 的 index 超出第 ${s.step} 步的条数`);
      }
      if ((s.op === "send" || s.op === "batch" || s.op === "filler") && s.to) for (const k of s.to) if (!rooms.get(s.room)?.contacts.includes(k)) out.push(`${at} 第 ${i} 步 @ 的 ${k} 不在会话 ${s.room} 里`);
      for (const t of stepTexts(set, item, i)) {
        if ([...t].length < 6) out.push(`${at} 第 ${i} 步的消息「${t}」太短(少于 6 个字符),覆盖判定按原文匹配`);
        if (seen.has(t)) out.push(`${at} 消息「${t}」在同一题里出现两次,覆盖判定无法区分`);
        seen.add(t);
      }
    });
    for (const p of item.probes) {
      const s = item.steps[p.step];
      if (s?.op !== "send" || s.probe !== p.id) {
        out.push(`${at} 追问 ${p.id} 指向的第 ${p.step} 步不是带同名 probe 的 send`);
        continue;
      }
      for (const [k, src] of [["expect", p.expect], ["reject", p.reject], ["misled", p.misled]] as const) if (src !== null && !compiles(src)) out.push(`${at} 追问 ${p.id} 的 ${k} 不是合法正则`);
      if (p.expect !== null && compiles(p.expect) && new RegExp(p.expect, "i").test(s.text)) out.push(`${at} 追问 ${p.id} 的 expect 命中了问题原文,复读就算答对`);
      if (p.needs !== null && s.text.includes(p.needs)) out.push(`${at} 追问 ${p.id} 的 needs 出现在问题原文里,读回判定无意义`);
    }
    for (const m of item.memories.expect) {
      if (!contacts.has(m.contact)) out.push(`${at} 期望记忆 ${m.id} 的联系人 ${m.contact} 不存在`);
      if (!sendsTo(item.steps[m.sourceStep])) out.push(`${at} 期望记忆 ${m.id} 的来源第 ${m.sourceStep} 步不是发消息的步`);
      if (!compiles(m.match)) out.push(`${at} 期望记忆 ${m.id} 的 match 不是合法正则`);
    }
    for (const m of item.memories.forbid) {
      if (!contacts.has(m.contact)) out.push(`${at} 禁写记忆 ${m.id} 的联系人 ${m.contact} 不存在`);
      if (!compiles(m.match)) out.push(`${at} 禁写记忆 ${m.id} 的 match 不是合法正则`);
    }
    for (const f of item.forbidden) {
      if (!contacts.has(f.contact)) out.push(`${at} 禁入原文的联系人 ${f.contact} 不存在`);
      if (f.text.trim() === "") out.push(`${at} 禁入原文为空`);
      if (f.afterStep < -1 || f.afterStep >= item.steps.length) out.push(`${at} 禁入原文的 afterStep ${f.afterStep} 越界`);
    }
    for (const f of item.faults) {
      if (!contacts.has(f.contact)) out.push(`${at} 故障注入的联系人 ${f.contact} 不存在`);
      if (!Number.isSafeInteger(f.nth) || f.nth < 1) out.push(`${at} 故障注入的 nth 必须是正整数`);
    }
  }
  return out;
}

export function loadFixtureSet(file: string): FixtureSet {
  const set = JSON.parse(readFileSync(file, "utf8")) as FixtureSet;
  const problems = validateFixtureSet(set);
  if (problems.length) throw new Error(`题集 ${file} 不合格:\n${problems.join("\n")}`);
  return set;
}
