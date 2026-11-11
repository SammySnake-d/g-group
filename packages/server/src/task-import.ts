// tasks.importCsv(US1 后端):CSV 每个数据行建成该群的一个任务。解析用内核的 parseCsv(RFC 4180);
// 每行走 host.createTask(以用户的一条消息记进会话、带任务卡),没有负责人时停在 T1_Open 待认领,由群里联系人认领。
// 逐行判定:一行出错(空行、缺列、标题为空、负责人不是本会话联系人、建任务被拒)只记进 errors,不影响别的行。
import type { TaskView } from "@g-group/api-contract";
import type { Host } from "./host.ts";

export interface ImportCsvInput {
  readonly clientActionId: string;
  readonly roomId: string;
  readonly csv: string;
  readonly titleColumn?: string;
  readonly assigneeColumn?: string;
}
export interface ImportCsvResult {
  tasks: TaskView[];
  errors: { line: number; reason: string }[];
}

/** 一次最多导入的数据行。 */
export const IMPORT_MAX_ROWS = 500;

/** 空壳:待实现。 */
export function importCsvTasks(_host: Host, _input: ImportCsvInput): ImportCsvResult {
  return { tasks: [], errors: [] };
}
