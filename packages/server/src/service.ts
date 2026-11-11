// 按 @g-group/api-contract 对外:handle(method, params) 校验参数 → 调宿主 → 校验结果;subscribe 推事件流。
// Electron 主进程用 bindIpc 把它挂到 ipcMain;CLI 与测试直接调 handle。
import {
  API_VERSION,
  type ApiResult,
  type ErrorCode,
  type MethodName,
  type ServerEvent,
  type SlashCommand,
  checkParams,
  checkResult,
  formatIssues,
  isMethodName,
} from "@g-group/api-contract";
import type { AnnouncementOrder } from "./announcements.ts";
import { HostError } from "./db.ts";
import { type HelperEntryInput, HelperDesk } from "./helper.ts";
import type { Host } from "./host.ts";
import { previewCron } from "./schedules.ts";
import { contactProfile, listFiles, readFile } from "./views.ts";

type Handler = (p: never) => unknown;
export const BUILTIN_COMMANDS: readonly SlashCommand[] = Object.freeze([
  { name: "task", description: "把一件事交给会话里的联系人(群里要选联系人)", args: [{ name: "contact", description: "交给谁", kind: "contact", required: false }, { name: "what", description: "要做什么", kind: "text", required: true }], source: "builtin", pluginId: null, targetContactId: null },
  { name: "remind", description: "让联系人按 cron 定时做事", args: [{ name: "cron", description: "cron 表达式,如 0 8 * * *", kind: "cron", required: true }, { name: "what", description: "到点做什么", kind: "text", required: true }, { name: "contact", description: "谁来做", kind: "contact", required: false }], source: "builtin", pluginId: null, targetContactId: null },
  { name: "stop", description: "停止一个进行中的任务", args: [{ name: "task", description: "任务 id 或标题里的词", kind: "text", required: true }], source: "builtin", pluginId: null, targetContactId: null },
]);

export interface Service {
  handle(method: string, params: unknown): Promise<ApiResult<MethodName>>;
  subscribe(listener: (e: ServerEvent) => void, sinceEventSeq?: number): () => void;
}

export function createService(host: Host): Service {
  const helper = new HelperDesk(host);
  const H: { [M in MethodName]: Handler } = {
    "session.hello": () => ({ apiVersion: API_VERSION, serverTime: new Date().toISOString(), eventSeq: host.bus.head(), userId: host.userId }),
    "contacts.list": () => ({ contacts: host.listContacts() }),
    "contacts.get": (p: { contactId: string }) => host.contactView(host.contactDoc(p.contactId).value),
    "contacts.create": (p: Parameters<Host["createContact"]>[0]) => host.createContact(p),
    "contacts.update": ({ contactId, ...patch }: { contactId: string } & Parameters<Host["updateContact"]>[1]) => host.updateContact(contactId, patch),
    "contacts.profile": (p: { contactId: string }) => contactProfile(host, p.contactId),
    "capabilities.list": () => host.capabilities.list(),
    "contacts.remove": (p: { contactId: string }) => {
      host.removeContact(p.contactId);
      return { ok: true };
    },
    "rooms.list": () => ({ rooms: host.roomsOfUser() }),
    "rooms.get": (p: { roomId: string }) => host.roomView(p.roomId),
    "rooms.openDm": (p: { contactId: string }) => host.openDm(p.contactId),
    "rooms.createGroup": (p: { title: string; members: { kind: "user" | "contact"; id: string }[] }) => host.createGroup(p.title, p.members),
    "rooms.update": ({ roomId, ...patch }: { roomId: string } & Parameters<Host["updateRoom"]>[1]) => host.updateRoom(roomId, patch),
    "rooms.addMembers": (p: { roomId: string; members: { kind: "user" | "contact"; id: string }[] }) => host.addMembers(p.roomId, p.members),
    "rooms.removeMember": (p: { roomId: string; member: { kind: "user" | "contact"; id: string }; stopTasks?: boolean }) =>
      host.removeMember(p.roomId, p.member, p.stopTasks === undefined ? {} : { stopTasks: p.stopTasks }),
    "rooms.markRead": (p: { roomId: string; seq: number }) => {
      host.markRead(p.roomId, { kind: "user", id: host.userId }, p.seq);
      return { ok: true };
    },
    "announcements.list": (p: { roomId: string; order?: AnnouncementOrder }) => ({ announcements: host.announcements.list(p.roomId, p.order) }),
    "announcements.add": (p: { roomId: string; clientActionId: string; text: string }) => host.announcements.add(p.roomId, p.text, p.clientActionId),
    "announcements.update": (p: { announcementId: string; text: string; expectedVersion?: number }) => host.announcements.update(p.announcementId, p.text, p.expectedVersion),
    "announcements.remove": (p: { announcementId: string; expectedVersion?: number }) => {
      host.announcements.remove(p.announcementId, p.expectedVersion);
      return { ok: true };
    },
    "rooms.rewindPreview": (p: { roomId: string; toSeq: number }) => host.rewindPreview(p.roomId, p.toSeq),
    "rooms.rewind": (p: { roomId: string; toSeq: number; clientActionId: string }) => host.rewind(p),
    "messages.list": ({ roomId, ...q }: { roomId: string } & Parameters<Host["listMessages"]>[1]) => host.listMessages(roomId, q),
    "messages.send": (p: Parameters<Host["send"]>[0]) => host.send(p),
    "messages.edit": (p: { roomId: string; seq: number; text: string }) => host.editMessage(p.roomId, p.seq, p.text),
    "messages.retract": (p: { roomId: string; seq: number }) => host.retractMessage(p.roomId, p.seq),
    "messages.react": (p: { roomId: string; seq: number; emoji: string; on: boolean }) => host.react(p.roomId, p.seq, p.emoji, p.on),
    "messages.receipts": (p: { roomId: string; seq: number }) => host.receipts(p.roomId, p.seq),
    "drafts.get": (p: { roomId: string }) => host.draft(p.roomId),
    "drafts.save": (p: { roomId: string; expectedVer: number; draft: Parameters<Host["saveDraft"]>[2] }) => host.saveDraft(p.roomId, p.expectedVer, p.draft),
    "search.messages": (p: Parameters<Host["searchMessages"]>[0]) => host.searchMessages(p),
    "attachments.add": (p: { path: string }) => host.addAttachment(p.path),
    "files.list": (p: { roomId: string }) => ({ files: listFiles(host, p.roomId) }),
    "files.read": (p: { ref: string; maxBytes?: number }) => readFile(host, p.ref, p.maxBytes),
    "cards.act": (p: Parameters<Host["cardAct"]>[0]) => host.cardAct(p),
    "tasks.list": (p: Parameters<Host["listTasks"]>[0] & { limit?: number }) => ({ tasks: host.listTasks(p).slice(0, p.limit ?? 200) }),
    "tasks.get": (p: { taskId: string }) => host.taskViewById(p.taskId),
    "tasks.progress": (p: { taskId: string; limit?: number }) => {
      host.taskDoc(p.taskId);
      return { progress: host.progress(p.taskId, p.limit ?? 200) };
    },
    "tasks.accept": (p: { taskId: string; clientActionId: string }) => host.taskDecision(p.taskId, "accept", p.clientActionId),
    "tasks.reject": (p: { taskId: string; clientActionId: string; feedback: string }) => host.taskDecision(p.taskId, "reject", p.clientActionId, p.feedback),
    "tasks.answer": (p: { taskId: string; qId: string; clientActionId: string; answer: string }) => host.answerTask(p.taskId, p.qId, p.clientActionId, p.answer),
    "tasks.cancel": (p: { taskId: string; clientActionId: string }) => host.taskDecision(p.taskId, "cancel", p.clientActionId),
    "tasks.create": (p: Parameters<Host["createTask"]>[0]) => host.createTask(p),
    "tasks.assign": (p: Parameters<Host["assignTask"]>[0]) => host.assignTask(p),
    "tasks.integrate": (p: { taskId: string }) => host.integrateTask(p.taskId),
    "artifacts.get": (p: { ref: string }) => host.getArtifact(p.ref),
    "tasks.rebindFollowUp": (p: Parameters<Host["rebindFollowUp"]>[0]) => host.rebindFollowUp(p),
    "runs.list": (p: Parameters<Host["listRuns"]>[0]) => host.listRuns(p),
    "runs.get": (p: { runId: string }) => host.getRun(p.runId),
    "runs.rerun": (p: { runId: string; clientActionId: string }) => host.rerunRun(p.runId, p.clientActionId),
    "commitments.list": (p: Parameters<Host["listCommitments"]>[0]) => ({ commitments: host.listCommitments(p) }),
    "commitments.revoke": (p: { commitmentId: string }) => host.revokeCommitment(p.commitmentId),
    "docs.list": (p: { roomId?: string }) => ({ docs: host.docs.list(p) }),
    "docs.get": (p: { docId: string; version?: number }) => host.docs.get(p.docId, p.version),
    "docs.create": (p: { clientActionId: string; title: string; content: string; roomId?: string | null }) => host.docs.create(p, { kind: "user", id: host.userId }),
    "docs.commit": (p: { docId: string; requestId: string; baseVersion: number; content: string; title?: string }) => host.docs.commit(p, { kind: "user", id: host.userId }),
    "docs.history": (p: { docId: string; limit?: number }) => ({ versions: host.docs.history(p.docId, p.limit ?? 50) }),
    "schedules.list": (p: { contactId?: string; roomId?: string; order?: "next-run" | "created" }) => ({ schedules: host.scheduler.list(p) }),
    "schedules.preview": (p: { cron: string; tz: string; count?: number }) => previewCron(p.cron, p.tz, p.count ?? 5, Date.now()),
    "schedules.create": ({ clientActionId, ...p }: { clientActionId: string } & Parameters<Host["scheduler"]["create"]>[0]) => host.scheduler.create(p, { clientActionId }),
    "schedules.update": ({ scheduleId, ...patch }: { scheduleId: string } & Parameters<Host["scheduler"]["update"]>[1]) => host.scheduler.update(scheduleId, patch),
    "schedules.remove": (p: { scheduleId: string }) => {
      host.removeSchedule(p.scheduleId);
      return { ok: true };
    },
    "schedules.runNow": (p: { scheduleId: string }) => host.scheduler.runNow(p.scheduleId),
    "schedules.history": (p: { scheduleId: string; limit?: number }) => ({ runs: host.scheduler.history(p.scheduleId, p.limit ?? 50) }),
    "plugins.marketplace": (p: { query?: string; kind?: string }) => ({ entries: host.plugins.marketplace(p) }),
    "plugins.list": () => ({ plugins: host.plugins.list() }),
    "plugins.get": (p: { pluginId: string }) => host.plugins.get(p.pluginId),
    "plugins.install": (p: { source: Parameters<Host["plugins"]["install"]>[0]; grantedPermissions: string[] }) => host.plugins.install(p.source, p.grantedPermissions),
    "plugins.setEnabled": (p: { pluginId: string; enabled: boolean }) => host.plugins.setEnabled(p.pluginId, p.enabled),
    "plugins.configure": (p: { pluginId: string; config: unknown }) => host.plugins.configure(p.pluginId, p.config),
    "plugins.update": (p: { pluginId: string; version?: string; grantedPermissions?: string[] }) => host.plugins.update(p.pluginId, p.version, p.grantedPermissions),
    "plugins.pull": (p: { pluginId: string; sourceId?: string }) => host.plugins.pull(p.pluginId, p.sourceId),
    "plugins.send": (p: { pluginId: string; actionId: string; payload: string }) => host.plugins.send(p.pluginId, p.actionId, p.payload),
    "plugins.uninstall": (p: { pluginId: string }) => {
      host.plugins.uninstall(p.pluginId);
      return { ok: true };
    },
    "commands.list": (p: { roomId: string; prefix?: string }) => {
      host.roomView(p.roomId);
      return { commands: [...BUILTIN_COMMANDS, ...host.plugins.commands()].filter((c) => !p.prefix || c.name.startsWith(p.prefix)) };
    },
    "helper.context": (p: { entry: HelperEntryInput; readRoomIds?: string[]; limit?: number }) => helper.context(p.entry, p.readRoomIds ?? [], p.limit ?? 100),
    "helper.note": (p: { entry: HelperEntryInput; role: "user" | "helper"; text: string; clientActionId: string }) => helper.note(p.entry, p.role, p.text, p.clientActionId),
    "helper.history": (p: { entry: HelperEntryInput; limit?: number }) => ({ notes: helper.history(p.entry, p.limit ?? 200) }),
    "helper.post": (p: { entry: HelperEntryInput; text: string; clientActionId: string }) => helper.post(p.entry, p.text, p.clientActionId),
    "models.preview": (p: { change: Parameters<Host["previewModelChange"]>[0] }) => host.previewModelChange(p.change),
    "models.batchReplace": (p: { from: string; to: string; apply?: boolean; confirmAffected?: boolean }) =>
      host.batchReplaceModels(p.from, p.to, { ...(p.apply !== undefined ? { apply: p.apply } : {}), ...(p.confirmAffected !== undefined ? { confirmAffected: p.confirmAffected } : {}) }),
    "settings.get": () => host.settings(),
    "settings.update": (p: Parameters<Host["updateSettings"]>[0]) => host.updateSettings(p),
  };
  const err = (code: ErrorCode, message: string, detail?: unknown): ApiResult<MethodName> => ({ ok: false, error: detail === undefined ? { code, message } : { code, message, detail } });
  return {
    async handle(method, params) {
      if (!isMethodName(method)) return err("unknown_method", `没有方法 ${String(method)}`);
      const p = checkParams(method, params);
      if (!p.ok) return err("invalid_params", formatIssues(p.issues), p.issues);
      try {
        const value = await (H[method] as (x: unknown) => unknown)(p.value);
        const r = checkResult(method, value);
        if (!r.ok) return err("internal", `结果不符合合同:${formatIssues(r.issues)}`);
        return { ok: true, value: r.value } as ApiResult<MethodName>;
      } catch (e) {
        if (e instanceof HostError) return err(e.code, e.message, e.detail);
        return err("internal", e instanceof Error ? e.message : String(e));
      }
    },
    subscribe: (l, since) => host.bus.subscribe(l, since),
  };
}

/** Electron 主进程接线:ipcMain.handle(gg:invoke) + 每个 webContents 订阅事件。只依赖结构类型,不引 electron。 */
export interface IpcMainLike {
  handle(channel: string, fn: (event: { sender: WebContentsLike }, ...args: unknown[]) => unknown): void;
  on(channel: string, fn: (event: { sender: WebContentsLike }, ...args: unknown[]) => void): void;
}
export interface WebContentsLike {
  readonly id: number;
  send(channel: string, payload: unknown): void;
  once(event: "destroyed", fn: () => void): void;
}
export function bindIpc(ipc: IpcMainLike, service: Service, channels = { invoke: "gg:invoke", subscribe: "gg:subscribe", unsubscribe: "gg:unsubscribe", event: "gg:event" }) {
  const subs = new Map<number, () => void>();
  ipc.handle(channels.invoke, (_e, req) => {
    const r = req as { method?: unknown; params?: unknown } | null;
    return service.handle(typeof r?.method === "string" ? r.method : "", r?.params);
  });
  ipc.on(channels.subscribe, (e, opts) => {
    subs.get(e.sender.id)?.();
    const since = (opts as { sinceEventSeq?: unknown } | null)?.sinceEventSeq;
    const off = service.subscribe((ev) => e.sender.send(channels.event, ev), typeof since === "number" ? since : undefined);
    subs.set(e.sender.id, off);
    e.sender.once("destroyed", () => {
      off();
      subs.delete(e.sender.id);
    });
  });
  ipc.on(channels.unsubscribe, (e) => {
    subs.get(e.sender.id)?.();
    subs.delete(e.sender.id);
  });
}
