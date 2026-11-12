// P7 命令路由。宿主只提供本次选中会话的只读快照；插件正文经独立进程生成。
// 命令执行账本与外发 outbox 无关：断电留下 running 时拒绝盲重跑，用户可用新 action 明确再试。
import { createHash } from "node:crypto";
import type { MessageView } from "@g-group/api-contract";
import { HostError, all, one, run } from "./db.ts";
import type { Host } from "./host.ts";

const BUILTIN = new Set(["task", "remind", "stop"]);
const SCHEMA = `CREATE TABLE IF NOT EXISTS gg_plugin_commands (
 room_id TEXT NOT NULL, action_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
 status TEXT NOT NULL, result_seq INTEGER, result_text TEXT, error TEXT, PRIMARY KEY(room_id,action_id)
)`;
interface CommandRow { fingerprint: string; status: string; result_seq: number | null; result_text: string | null; error: string | null }

/** JSON 参数对象的属性顺序不改变同一逻辑命令的身份。 */
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, value]) => [k, canonical(value)]));
  return v;
}

/** API 的 command.args 是 unknown；仅已知插件命令要求参数记录，未知与内置命令保持原路由。 */
function commandArgs(args: unknown): Record<string, unknown> {
  if (args === null || typeof args !== "object" || Array.isArray(args)) throw new HostError("invalid_params", "插件命令 args 必须是对象");
  return args as Record<string, unknown>;
}

/** 当前会话的可见消息与任务状态，不含别群、草稿、凭据或宿主句柄。 */
export function commandSnapshot(host: Host, roomId: string, from?: unknown) {
  host.roomView(roomId);
  const commandSeqs = new Set(all<{ result_seq: number }>(host.db, "SELECT result_seq FROM gg_plugin_commands WHERE room_id = ? AND status = 'done'", roomId).map(r => r.result_seq));
  const visible: MessageView[] = [];
  let beforeSeq: number | undefined;
  for (;;) {
    const page = host.listMessages(roomId, { limit: 200, ...(beforeSeq === undefined ? {} : { beforeSeq }) });
    visible.unshift(...page.messages.filter(m => !commandSeqs.has(m.seq) && !m.retracted && !m.rewound));
    if (!page.hasMore || page.messages.length === 0) break;
    beforeSeq = page.messages[0]!.seq;
  }
  const toSeq = visible.at(-1)?.seq ?? 0;
  const fromSeq = from === undefined ? host.readSeq(roomId, { kind: "user", id: host.userId }) : from;
  if (typeof fromSeq !== "number" || !Number.isSafeInteger(fromSeq) || fromSeq < 0 || fromSeq > host.lastSeq(roomId)) throw new HostError("invalid_params", "from 必须是本会话范围内的非负消息序号");
  const unread = visible.filter(m => m.seq > fromSeq);
  const contacts = new Map(host.listContacts().map(c => [c.id, c.name]));
  const tasks = host.listTasks({ roomId }).map(t => ({ id: t.id, title: t.title, state: t.state, sourceSeq: t.sourceSeq, deliveredSeq: host.taskDoc(t.id).value.deliveredSeq ?? null, updatedAt: t.updatedAt }));
  const pending = visible.filter(m => m.card?.kind === "question" && m.card.state === "open").map(m => ({ kind: m.card!.actions.some(a => a.actionId === "approve") ? "authorization" : "question", taskId: m.card!.taskId, title: m.card!.title, seq: m.seq }));
  for (const t of tasks) if (t.deliveredSeq !== null && (t.state === "T8a_Delivered" || t.state === "T5_InReview")) pending.push({ kind: "delivery", taskId: t.id, title: t.title, seq: t.deliveredSeq });
  const boundaryAt = visible.find(m => m.seq === fromSeq)?.at ?? null;
  return { roomId, fromSeq, toSeq: Math.max(fromSeq, toSeq), truncated: unread.length > 200, messageCount: unread.length,
    messages: unread.slice(-200).map(m => ({ seq: m.seq, sender: m.sender, name: m.sender.kind === "user" ? (m.sender.id === host.userId ? "我" : m.sender.id) : contacts.get(m.sender.id) ?? "宿主", text: m.text })), tasks, pending, boundaryAt };
}

export class SlashCommands {
  private readonly host: Host;
  private readonly active = new Map<string, Promise<MessageView>>();
  constructor(host: Host) { this.host = host; host.db.store.db.exec(SCHEMA); }

  async send(input: Parameters<Host["send"]>[0]): Promise<MessageView> {
    const command = input.command;
    if (!command || BUILTIN.has(command.name)) return this.host.send(input);
    this.host.roomView(input.roomId);
    const fingerprint = createHash("sha256").update(JSON.stringify(canonical({ name: command.name, args: command.args, text: input.text }))).digest("hex");
    const key = JSON.stringify([input.roomId, input.clientActionId]);
    const prior = one<CommandRow>(this.host.db, "SELECT * FROM gg_plugin_commands WHERE room_id = ? AND action_id = ?", input.roomId, input.clientActionId);
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw new HostError("conflict", "同一个 clientActionId 已用于不同命令参数");
      if ((prior.status === "done" || prior.status === "rendered") && prior.result_text !== null) return this.publish(input, prior.result_text);
      const live = this.active.get(key);
      if (live) return live;
      throw new HostError("unavailable", prior.error ?? "上次命令执行中断,结果未确认;请检查后用新的 action 明确重试");
    }
    const known = this.host.plugins.commandOwner(command.name);
    if (!known) return this.host.send(input);
    if (!known.enabled) throw new HostError("conflict", `插件 ${known.pluginId} 已停用`);
    const args = commandArgs(command.args);
    const snapshot = known.canRead ? commandSnapshot(this.host, input.roomId, args.from) : null;
    run(this.host.db, "INSERT INTO gg_plugin_commands (room_id,action_id,fingerprint,status) VALUES (?,?,?,'running')", input.roomId, input.clientActionId, fingerprint);
    const work = this.execute(known.pluginId, input, snapshot);
    this.active.set(key, work);
    try { return await work; } finally { this.active.delete(key); }
  }

  private publish(input: Parameters<Host["send"]>[0], text: string): MessageView {
    const message = this.host.postSystemNotice(input.roomId, text, `plugin-command:${input.clientActionId}`);
    run(this.host.db, "UPDATE gg_plugin_commands SET status='done',result_seq=? WHERE room_id=? AND action_id=?", message.seq, input.roomId, input.clientActionId);
    return message;
  }

  private async execute(pluginId: string, input: Parameters<Host["send"]>[0], snapshot: ReturnType<typeof commandSnapshot> | null): Promise<MessageView> {
    try {
      const result = await this.host.plugins.command(pluginId, { name: input.command!.name, args: commandArgs(input.command!.args), roomId: input.roomId, userId: this.host.userId, text: input.text, snapshot });
      run(this.host.db, "UPDATE gg_plugin_commands SET status='rendered',result_text=? WHERE room_id=? AND action_id=?", result.text, input.roomId, input.clientActionId);
      return this.publish(input, result.text);
    } catch (e) {
      const message = (e as Error).message.slice(0, 2000);
      run(this.host.db, "UPDATE gg_plugin_commands SET status='failed',error=? WHERE room_id=? AND action_id=?", message, input.roomId, input.clientActionId);
      throw e instanceof HostError ? e : new HostError("unavailable", `插件命令失败:${message}`);
    }
  }
}

export function assertCommandNames(commands: readonly { readonly name: string }[], existing: readonly { readonly name: string; readonly pluginId: string | null }[], pluginId: string) {
  const seen = new Set<string>();
  for (const c of commands) {
    if (BUILTIN.has(c.name) || seen.has(c.name) || existing.some(e => e.name === c.name && e.pluginId !== pluginId)) throw new HostError("conflict", `命令 /${c.name} 已被占用,不安装或更新插件 ${pluginId}`);
    seen.add(c.name);
  }
}
