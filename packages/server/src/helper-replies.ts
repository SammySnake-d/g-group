import type { MessageView } from "@g-group/api-contract";
import { HELPER_ID, HelperDesk } from "./helper.ts";
import type { Host } from "./host.ts";
import type { SpeakingAssembly } from "./speaking.ts";

const system = "你是 Helper。请回答用户在当前会话里发给 Helper 的这条消息。只依据提供的会话和任务，直接输出回复正文。无法确认时如实回答，不编造软件操作。";

/** Subscribe to committed user mentions and reuse HelperDesk for scope and durable delivery. */
export function startHelperReplies(host: Host, generate: SpeakingAssembly["helperReply"], report?: (what: string, detail: unknown) => void) {
  if (!generate) return async () => {};
  const desk = new HelperDesk(host);
  const controller = new AbortController();
  const pending = new Set<Promise<void>>();

  async function reply(message: MessageView) {
    const entry = { kind: "mention" as const, roomId: message.roomId, seq: message.seq };
    const { rooms } = desk.context(entry);
    const messages = rooms[0]?.messages.filter(m => !m.retracted && m.seq < message.seq).map(({ seq, sender, text }) => ({ seq, sender, text }));
    const tasks = host.listTasks({ roomId: message.roomId }).map(({ title, state }) => ({ title, state }));
    const prompt = JSON.stringify({ history: messages, tasks, question: message.text });
    const text = await generate!(host.settingsView().defaultSpeakingModel, system, prompt, controller.signal);
    if (!controller.signal.aborted) desk.post(entry, text, `auto:${message.roomId}:${message.seq}`);
  }

  const off = host.bus.subscribe((e) => {
    if (e.type !== "message.appended" || e.message.sender.kind !== "user" || !e.message.mentions.some(m => m.id === HELPER_ID)) return;
    const work = reply(e.message).catch((error: unknown) => {
      if (!controller.signal.aborted) report?.("helper-reply-failed", { roomId: e.message.roomId, seq: e.message.seq, error: error instanceof Error ? error.message : String(error) });
    }).finally(() => pending.delete(work));
    pending.add(work);
  });
  return async () => {
    off();
    controller.abort();
    await Promise.allSettled(pending);
  };
}
