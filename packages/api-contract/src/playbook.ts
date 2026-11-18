import { arr, bool, id, isoTime, nullable, obj, oneOf, opt, seq, str, type Infer } from "./schema.ts";
import { RoomView, AnnouncementView } from "./entities.ts";
export const PlaybookView = obj({ id: id(), roomId: id(), sourceSeq: seq(), scope: oneOf(["team", "pair"] as const), subjectIds: arr(id()), title: str({ min: 1, max: 200 }), observation: str({ min: 1, max: 20000 }), createdBy: id(), createdAt: isoTime(), updatedAt: isoTime(), status: oneOf(["active", "invalidated"] as const), promotedAnnouncementId: opt(nullable(id())) });
export type PlaybookView = Infer<typeof PlaybookView>;
const method = <P, R>(params: P, result: R) => ({ params, result });
export const PLAYBOOK_METHODS = {
  "playbook.list": method(obj({ roomId: opt(id()), scope: opt(oneOf(["team", "pair"] as const)), status: opt(oneOf(["active", "invalidated"] as const)) }), obj({ entries: arr(PlaybookView) })),
  "playbook.record": method(obj({ roomId: id(), sourceSeq: seq(), scope: oneOf(["team", "pair"] as const), subjectIds: arr(id()), title: str({ min: 1, max: 200 }), observation: str({ min: 1, max: 20000 }), clientActionId: id() }), PlaybookView),
  "playbook.invalidate": method(obj({ entryId: id() }), PlaybookView),
  "playbook.remove": method(obj({ entryId: id() }), obj({ removed: bool() })),
  "playbook.promoteToAnnouncement": method(obj({ entryId: id(), roomId: id(), clientActionId: id() }), AnnouncementView),
  "rooms.clone": method(obj({ fromRoomId: id(), title: opt(str({ min: 1, max: 200 })), contactIds: opt(arr(id())), copyRules: opt(bool()), copyAnnouncements: opt(bool()), copyPlaybook: opt(bool()), clientActionId: id() }), RoomView),
} as const;
