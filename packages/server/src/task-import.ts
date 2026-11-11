// tasks.importCsv(US1 后端):CSV 每个数据行建成该群的一个任务。解析用内核的 parseCsv(RFC 4180);
// 每行走 host.createTask(以用户的一条消息记进会话、带任务卡),没有负责人时停在 T1_Open 待认领,由群里联系人认领。
// 逐行判定:一行出错(空行、缺列、标题为空、负责人不是本会话联系人、建任务被拒)只记进 errors,不影响别的行。
import type { TaskView } from "@g-group/api-contract";
import { parseCsv } from "@g-group/kernel";
import { HostError } from "./db.ts";
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

/** 一次最多导入的数据行;多出来的整体记一条错误。 */
export const IMPORT_MAX_ROWS = 500;
const TITLE_NAMES = /^(title|标题|任务|任务名|任务名称|名称|name)$/i;

export function importCsvTasks(host: Host, input: ImportCsvInput): ImportCsvResult {
  const room = host.roomView(input.roomId);
  if (!host.members(room.id).some((m) => m.kind === "user" && m.id === host.userId)) throw new HostError("forbidden", "你不在这个会话里");
  const parsed = parseCsv(input.csv);
  if (!parsed.ok) throw new HostError("invalid_params", `CSV 不能导入:${parsed.reason}`);
  const { header } = parsed;
  if (input.titleColumn !== undefined && !header.includes(input.titleColumn)) throw new HostError("invalid_params", `表头里没有标题列「${input.titleColumn}」(表头:${header.join("、")})`);
  if (input.assigneeColumn !== undefined && !header.includes(input.assigneeColumn)) throw new HostError("invalid_params", `表头里没有负责人列「${input.assigneeColumn}」(表头:${header.join("、")})`);
  const titleCol = input.titleColumn ?? header.find((h) => TITLE_NAMES.test(h)) ?? header[0]!;
  const assigneeCol = input.assigneeColumn ?? null;
  const contacts = host.listContacts();
  const here = new Set(host.members(room.id).filter((m) => m.kind === "contact").map((m) => m.id));
  const errors: { line: number; reason: string }[] = [...parsed.errors];
  const tasks: TaskView[] = [];
  const rows = parsed.rows.slice(0, IMPORT_MAX_ROWS);
  if (parsed.rows.length > IMPORT_MAX_ROWS) errors.push({ line: parsed.rows[IMPORT_MAX_ROWS]!.line, reason: `一次最多导入 ${IMPORT_MAX_ROWS} 行,从这行起的 ${parsed.rows.length - IMPORT_MAX_ROWS} 行没有导入` });
  for (const row of rows) {
    const title = (row.cells[titleCol] ?? "").trim();
    if (!title) {
      errors.push({ line: row.line, reason: `标题列「${titleCol}」为空` });
      continue;
    }
    let owner: string | undefined;
    const who = assigneeCol ? (row.cells[assigneeCol] ?? "").trim() : "";
    if (who) {
      const c = contacts.find((x) => here.has(x.id) && (x.id === who || x.name === who));
      if (!c) {
        errors.push({ line: row.line, reason: `负责人「${who}」不是这个会话里的联系人` });
        continue;
      }
      owner = c.id;
    }
    const description = header
      .filter((h) => h !== titleCol && h !== assigneeCol && (row.cells[h] ?? "").trim() !== "")
      .map((h) => `${h}:${row.cells[h]}`)
      .join("\n");
    try {
      tasks.push(
        host.createTask({
          clientActionId: `${input.clientActionId}:L${row.line}`,
          roomId: room.id,
          title,
          ...(description ? { description } : {}),
          ...(owner !== undefined ? { ownerContactId: owner } : {}),
        }),
      );
    } catch (e) {
      if (!(e instanceof HostError)) throw e;
      errors.push({ line: row.line, reason: e.message });
    }
  }
  errors.sort((x, y) => x.line - y.line);
  return { tasks, errors };
}
