// 联系人的 progress_get(需求文档 D26 第 4 节,AC-43 ①④、U91):按 id 查运行台账里一个单元。
// 可见范围由宿主机械判(kernel visibleRuns,不看联系人自报):私聊里只看这位联系人在这个私聊里的单元,群里看本群全部成员在本群的单元,
// 别的群、别人私聊、不在的会话都看不到;看不到和没有这个单元回同一句,不泄露别处有没有。
// 返回的是台账字段(状态、原因类别与原文、用时、最后进展、阈值、子单元、最近事件),不是日志全文;子单元与事件条数有界。
import { type RunUnit, type RunViewer, visibleRuns } from "@g-group/kernel";
import type { RunStore } from "./runs.ts";

/** 一次最多带几个子单元、几条最近事件 */
export const PROGRESS_GET_MAX_CHILDREN = 20;
export const PROGRESS_GET_MAX_EVENTS = 10;
/** 原因原文与事件详情各截到多少字 */
const RAW_CHARS = 2000;
const DETAIL_CHARS = 300;

/**
 * 联系人在 roomId 里查单元 id;rooms 是这位联系人此刻所在的会话。roomId 不是它的会话、单元看不到或没有,都返回 null。
 */
export function progressGet(runs: RunStore, contactId: string, rooms: readonly { readonly id: string; readonly kind: string }[], roomId: string, id: string): string | null {
  const room = rooms.find((r) => r.id === roomId);
  if (!room) return null;
  const viewer: RunViewer = { kind: "contact", contactId, roomId, roomKind: room.kind === "dm" ? "dm" : "group" };
  const u = runs.get(id);
  if (!u || visibleRuns([u], viewer).length !== 1) return null;
  const v = runs.view(u);
  const kids = runs
    .childIds(u.id)
    .map((c) => runs.get(c))
    .filter((c): c is RunUnit => c !== null);
  const seen = visibleRuns(kids, viewer);
  const events = runs.events(u.id, PROGRESS_GET_MAX_EVENTS + 1);
  const recent = events.slice(-PROGRESS_GET_MAX_EVENTS);
  return JSON.stringify({
    unit: {
      id: v.id,
      layer: v.layer,
      status: v.status,
      text: v.text,
      reasonClass: v.reasonClass,
      label: v.label,
      raw: v.raw === null ? null : v.raw.slice(0, RAW_CHARS),
      retryClass: v.retryClass,
      note: v.note,
      roomId: v.roomId,
      sourceSeq: v.sourceSeq,
      contactId: v.contactId,
      taskId: v.taskId,
      parentId: v.parentId,
      upstream: v.upstream,
      startedAt: v.startedAt,
      endedAt: v.endedAt,
      durationMs: v.durationMs,
      lastProgressAt: v.lastProgressAt,
      waiting: v.waiting,
      idleMs: v.idleMs,
      thresholdMs: v.thresholdMs,
      thresholdSource: v.thresholdSource,
      rerunOf: v.rerunOf,
      attempt: v.attempt,
    },
    children: seen.slice(0, PROGRESS_GET_MAX_CHILDREN).map((c) => {
      const cv = runs.view(c);
      return { id: cv.id, layer: cv.layer, status: cv.status, text: cv.text, reasonClass: cv.reasonClass };
    }),
    childrenTotal: seen.length,
    events: recent.map((e) => ({ kind: e.kind, at: e.at, detail: JSON.stringify(e.detail).slice(0, DETAIL_CHARS) })),
    moreEvents: events.length > PROGRESS_GET_MAX_EVENTS,
  });
}
