import type { ParamsOf, PlaybookView, RoomView, AnnouncementView } from "@g-group/api-contract";
import type { Host } from "./host.ts";
export class PlaybookStore {
  readonly host: Host;
  constructor(host: Host) { this.host = host; }
  list(_p: ParamsOf<"playbook.list"> = {}): PlaybookView[] { throw new Error("P1-A playbook list not implemented"); }
  record(_p: ParamsOf<"playbook.record">): PlaybookView { throw new Error("P1-A playbook record not implemented"); }
  invalidate(_id: string): PlaybookView { throw new Error("P1-A playbook invalidate not implemented"); }
  remove(_id: string): { removed: boolean } { throw new Error("P1-A playbook remove not implemented"); }
  promote(_p: ParamsOf<"playbook.promoteToAnnouncement">): AnnouncementView { throw new Error("P1-A promotion not implemented"); }
  clone(_p: ParamsOf<"rooms.clone">): RoomView { throw new Error("P1-A clean clone not implemented"); }
}
