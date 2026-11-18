// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Milind Soni and OpenMausBot contributors
// Adapted from milind-soni/OpenMausBot (613ed01fd), licensed under Apache-2.0.

export interface RoomPostRecord {
  botId: string;
  text: string;
  at: number;
}

export interface RoomPostBudget {
  posts: RoomPostRecord[];
  trippedAt?: number;
}

export type RoomPostRefusal = "duplicate" | "ring" | "breaker" | "sender-rate" | "escalate";

export type RoomPostDecision =
  | { allowed: true; budget: RoomPostBudget }
  | { allowed: false; refusal: RoomPostRefusal; message: string; budget: RoomPostBudget };

export interface RoomPostAttempt {
  botId: string;
  botName: string;
  text: string;
  now: number;
  lastHumanAt?: number;
}

export function emptyRoomPostBudget(): RoomPostBudget { return { posts: [] }; }
export function decideRoomPost(budget: RoomPostBudget, _attempt: RoomPostAttempt): RoomPostDecision {
  return { allowed: false, refusal: "escalate", message: "", budget };
}
