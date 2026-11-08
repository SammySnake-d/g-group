// 联系人资料(AC-54)与会话文件(AC-57 文件列表与窗口联动)的读取接口。只读宿主已有状态,不建新存储:
// 预设 = 联系人文档 persona;工作记忆 = 状态笔记 note:<id>;职责 = 承诺账本 + 在途任务 + 定时 + 所在会话。
// 文件 = 会话消息里的附件(gg_attachments)+ 本会话任务的结果(task:<id>/result);工件存储方式不在这里改。
import type { ContactProfileView, FileEntry } from "@g-group/api-contract";
import type { Host } from "./host.ts";

export function contactProfile(_host: Host, _contactId: string): ContactProfileView {
  throw new Error("未实现");
}
export function listFiles(_host: Host, _roomId: string): FileEntry[] {
  throw new Error("未实现");
}
export function readFile(_host: Host, _ref: string, _maxBytes?: number): { ref: string; name: string; mime: string; bytes: number; encoding: "text" | "base64"; content: string; truncated: boolean } {
  throw new Error("未实现");
}
