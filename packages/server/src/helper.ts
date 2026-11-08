// Helper 三种意图(U94/D28 第 1 条)的后端接口:上下文读取范围、侧栏/全局问答记录、@Helper 时在聊天里公开回复。
// 权限按 domain/helper.ts 的 routeHelper:Helper 只为用户本人服务;回复出现在哪,跟着在哪叫它走。
import type { MessageView } from "@g-group/api-contract";
import type { Host } from "./host.ts";

/** Helper 在会话里的发言者 id;用户 @Helper 时 mentions 里写它。 */
export const HELPER_ID = "helper";

export type HelperEntryInput = { kind: "global" } | { kind: "sidebar"; roomId: string } | { kind: "mention"; roomId: string; seq: number };
export interface HelperRouteView {
  replyIn: "global-panel" | "conversation" | "sidebar";
  becomesMessage: boolean;
  contextRoomId: string | null;
  replyToSeq: number | null;
}
export interface HelperNoteView {
  id: string;
  scope: "global" | "sidebar";
  roomId: string | null;
  role: "user" | "helper";
  text: string;
  at: string;
}

export class HelperDesk {
  private readonly host: Host;
  constructor(host: Host) {
    this.host = host;
  }
  context(_entry: HelperEntryInput, _readRoomIds: readonly string[] = [], _limit = 100): { route: HelperRouteView; rooms: { roomId: string; title: string; messages: MessageView[] }[] } {
    throw new Error("未实现");
  }
  note(_entry: HelperEntryInput, _role: "user" | "helper", _text: string, _clientActionId: string): HelperNoteView {
    throw new Error("未实现");
  }
  history(_entry: HelperEntryInput, _limit = 200): HelperNoteView[] {
    throw new Error("未实现");
  }
  post(_entry: HelperEntryInput, _text: string, _clientActionId: string): MessageView {
    throw new Error("未实现");
  }
}
