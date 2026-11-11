// G6 固定题集:校验、展开与冻结摘要。题集一旦冻结,摘要进清单;改一个字就是另一套题,不和旧结果比。
// 红提交空壳:签名在、返回假值(undefined),实现见下一个提交。
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { FixtureItem, FixtureSet, FixtureStep } from "./types.ts";

/** 键排序后的 JSON,同内容同串;摘要与配置指纹都用它。 */
export function canonicalJson(v: unknown): string { return undefined as never; }

export function fixtureDigest(set: FixtureSet): string { return undefined as never; }

/** 一步实际发出的原文(filler 按题内出现顺序从公共填充句里轮流取,同一题内不重复)。edit/retract 不发新消息。 */
export function stepTexts(set: FixtureSet, item: FixtureItem, step: number): string[] { return undefined as never; }

const compiles = (src: string): boolean => { return undefined as never; };
const sendsTo = (s: FixtureStep | undefined): s is Extract<FixtureStep, { op: "send" | "batch" }> => undefined as never;

/** 题集自检:出问题返回逐条说明,空数组才算能跑。不改输入。 */
export function validateFixtureSet(set: FixtureSet): string[] { return undefined as never; }

export function loadFixtureSet(file: string): FixtureSet { return undefined as never; }
