// 群聊派活驱动:CLI `group` 命令与真实运行用。建(或复用)群与联系人 → 用户在群里 @ 某联系人发一条 → 等联系人与任务都收尾;
// 另给 AC-03 发言者核对:群消息的发言者只能是用户或联系人,Compute 实例不能出现在发言者里。
import type { ContactView, MessageView, RoomView } from "@g-group/api-contract";
import type { Host } from "./host.ts";

export interface DriveRun {
  readonly sent: MessageView;
  readonly transcript: MessageView[];
  readonly timedOut: boolean;
}
export interface SenderOffender {
  readonly seq: number;
  readonly sender: MessageView["sender"];
  readonly reason: string;
}

/** 按名字建(或复用)联系人与群;群按标题复用,缺的成员补进去。 */
export function ensureGroup(_host: Host, _title: string, _names: readonly string[]): { room: RoomView; contacts: ContactView[] } {
  throw new Error("未实现");
}

/** 用户在会话里发一条(mention 按联系人名字 @),等到联系人空闲、没有执行中的任务;超过 timeoutMs 记 timedOut。 */
export async function sendAndWait(_host: Host, _roomId: string, _text: string, _o: { mention?: string; timeoutMs: number; settleMs?: number }): Promise<DriveRun> {
  throw new Error("未实现");
}

/** AC-03:逐条核对会话消息的发言者。 */
export function senderAudit(_host: Host, _roomId: string): { ok: boolean; checked: number; offenders: SenderOffender[] } {
  throw new Error("未实现");
}
