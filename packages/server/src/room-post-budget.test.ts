// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Milind Soni and OpenMausBot contributors
// Adapted from milind-soni/OpenMausBot (613ed01fd), licensed under Apache-2.0.

// Every window is exercised from both sides, and every state is built through decideRoomPost, never by hand.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  decideRoomPost,
  emptyRoomPostBudget,
  type RoomPostBudget,
  type RoomPostRefusal,
} from "./room-post-budget.ts";

const T0 = 1_760_000_000_000;

const post = (
  decide: typeof decideRoomPost,
  budget: RoomPostBudget,
  botId: string,
  text: string,
  now: number,
) => {
  return decide(budget, { botId, botName: botId, text, now });
};

const seed = (
  entries: Array<{ botId: string; text: string; now: number }>,
): RoomPostBudget => {
  let budget = emptyRoomPostBudget();
  for (const entry of entries) {
    const decision = post(decideRoomPost, budget, entry.botId, entry.text, entry.now);
    if (!decision.allowed) throw new Error(`seed post was refused: ${decision.refusal}`);
    budget = decision.budget;
  }
  return budget;
};

/** Three distinct senders, one post each. */
const ringSetUp = (): RoomPostBudget =>
  seed([
    { botId: "a", text: "one", now: T0 },
    { botId: "b", text: "two", now: T0 + 1_000 },
    { botId: "c", text: "three", now: T0 + 2_000 },
  ]);

/** Ten different posts by one contact inside a minute. */
const floodedByOneBot = (): RoomPostBudget =>
  seed(
    Array.from({ length: 10 }, (_, i) => ({
      botId: "a",
      text: `flood ${i}`,
      now: T0 + i * 100,
    })),
  );

test("allows the first post into a quiet room and records it", () => {
  const decision = post(decideRoomPost, emptyRoomPostBudget(), "a", "hello", T0);
  assert.equal(decision.allowed, true);
  assert.deepEqual(decision.budget.posts, [{ botId: "a", text: "hello", at: T0 }]);
});

test("refuses an identical repost inside the duplicate window and allows it after", () => {
  const budget = seed([{ botId: "a", text: "same", now: T0 }]);
  const soon = post(decideRoomPost, budget, "a", "same", T0 + 59_999);
  assert.equal(soon.allowed, false);
  assert.equal(soon.allowed === false && soon.refusal, "duplicate");
  assert.equal(soon.budget.posts.length, 1);

  const later = post(decideRoomPost, budget, "a", "same", T0 + 60_001);
  assert.equal(later.allowed, true);
});

test("lets a different bot say the same words", () => {
  const budget = seed([{ botId: "a", text: "same", now: T0 }]);
  assert.equal(post(decideRoomPost, budget, "b", "same", T0 + 10).allowed, true);
});

test("two contacts can exchange six distinct posts without a human interrupting", () => {
  let budget = emptyRoomPostBudget();
  const decisions = [];
  for (let i = 0; i < 6; i++) {
    const decision = post(decideRoomPost, budget, i % 2 === 0 ? "a" : "b", `distinct point ${i}`, T0 + i * 1000);
    decisions.push(decision.allowed);
    budget = decision.budget;
  }
  assert.deepEqual(decisions, [true, true, true, true, true, true]);
  assert.equal(budget.posts.length, 6);
});

test("trips the breaker when a third bot closes the ring back onto the first", () => {
  const closing = post(decideRoomPost, ringSetUp(), "a", "four", T0 + 3_000);
  assert.equal(closing.allowed, false);
  assert.equal(closing.allowed === false && closing.refusal, "ring");
  assert.equal(closing.budget.trippedAt, T0 + 3_000);

  const afterwards = post(decideRoomPost, closing.budget, "d", "unrelated", T0 + 4_000);
  assert.equal(afterwards.allowed === false && afterwards.refusal, "breaker");
  const cooled = post(decideRoomPost, closing.budget, "d", "unrelated", T0 + 3_000 + 5 * 60_000 + 1);
  assert.equal(cooled.allowed, true);
});

test("does not call a two-bot back-and-forth a ring", () => {
  const budget = seed([
    { botId: "a", text: "one", now: T0 },
    { botId: "b", text: "two", now: T0 + 1_000 },
  ]);
  const third = post(decideRoomPost, budget, "a", "three", T0 + 2_000);
  assert.equal(third.allowed, true);
});

test("caps one bot at ten posts a minute, and lets the cap lapse with the minute", () => {
  const flooded = floodedByOneBot();
  assert.equal(flooded.posts.length, 10);
  const eleventh = post(decideRoomPost, flooded, "a", "one too many", T0 + 1_100);
  assert.equal(eleventh.allowed === false && eleventh.refusal, "sender-rate");

  const afterTheMinute = post(decideRoomPost, flooded, "a", "one too many", T0 + 60_100);
  assert.equal(afterTheMinute.allowed, true);
});

test("reaches every one of its rules from an empty budget", () => {
  const refusals = new Set<RoomPostRefusal>();
  const record = (decision: ReturnType<typeof post>) => {
    if (!decision.allowed) refusals.add(decision.refusal);
    return decision;
  };

  record(post(decideRoomPost, seed([{ botId: "a", text: "same", now: T0 }]), "a", "same", T0 + 1));
  record(post(decideRoomPost, floodedByOneBot(), "a", "one too many", T0 + 1_100));
  const ring = record(post(decideRoomPost, ringSetUp(), "a", "four", T0 + 3_000));
  const breaker = record(post(decideRoomPost, ring.budget, "d", "unrelated", T0 + 4_000));
  assert.equal(breaker.allowed, false);
  assert.equal(breaker.allowed || breaker.refusal, "breaker");

  assert.deepEqual([...refusals].sort(), ["breaker", "duplicate", "ring", "sender-rate"]);
});

test("tells the model to stop rather than to retry, whichever rule refuses", () => {
  const messages: string[] = [];
  const duplicate = post(decideRoomPost, seed([{ botId: "a", text: "same", now: T0 }]), "a", "same", T0 + 1);
  const ring = post(decideRoomPost, ringSetUp(), "a", "four", T0 + 3_000);
  const rate = post(decideRoomPost, floodedByOneBot(), "a", "one too many", T0 + 1_100);
  for (const decision of [duplicate, ring, rate]) {
    assert.equal(decision.allowed, false);
    if (decision.allowed) continue;
    messages.push(decision.message);
    assert.match(decision.message, /do not (retry|post|call)/i);
  }
  assert.equal(messages.length, 3);
  assert.match(rate.allowed ? "" : rate.message, /do not retry this call/i);
});

test("forgets posts older than every window it consults", () => {
  const budget = seed([{ botId: "a", text: "ancient", now: T0 }]);
  const decision = post(decideRoomPost, budget, "a", "fresh", T0 + 120_001);
  assert.equal(decision.allowed, true);
  assert.deepEqual(decision.budget.posts.map((entry) => entry.text), ["fresh"]);
});
