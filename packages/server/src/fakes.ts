// 测试与 CLI 演示用的确定性替身:脚本化的联系人脑子、按剧本吐语义事件的 Compute 适配器。不连模型、不起进程。
import type { ComputeAdapter, ComputeEvent, Refusal, SpawnResult, TurnModel } from "@g-group/adapter-cc-compute";
import type { ContactMind, Inbound, MindAction, RoundInput, RoundOutput } from "@g-group/kernel";

/** 规则脑子:用户在私聊或 @ 它派活 → dispatch + commit + 回复;Compute 里程碑 → 汇报;完成 → 交付;失败 → 如实告知。 */
export function scriptedMind(opts: { delayMs?: number; onRound?: (input: RoundInput) => void } = {}): ContactMind {
  return {
    async round(input, signal): Promise<RoundOutput> {
      opts.onRound?.(input);
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      if (signal.aborted) return { actions: [], stateNote: null };
      const actions: MindAction[] = [];
      const me = input.contact.id;
      for (const f of input.fresh) actions.push(...react(me, f));
      const last = input.fresh.at(-1);
      return { actions, stateNote: last ? `处理到 ${last.kind === "message" ? `${last.roomId} #${last.seq}` : `${last.kind}`}` : null };
    },
  };
}
function react(me: string, f: Inbound): MindAction[] {
  if (f.kind === "message") {
    if (f.sender.kind !== "user") return [];
    const dm = f.roomId.startsWith("dm-");
    if (!dm && !f.mentions.includes(me)) return [];
    const m = /^(?:帮我|请)(.+)$/.exec(f.text.trim());
    if (!m) return [{ kind: "reply", roomId: f.roomId, text: `收到:${f.text}`, replyToSeq: f.seq }];
    const what = m[1]!.trim();
    return [
      { kind: "dispatch", roomId: f.roomId, sourceSeq: f.seq, title: what.slice(0, 40), task: what },
      { kind: "commit", roomId: f.roomId, sourceSeq: f.seq, text: what, taskId: null },
      { kind: "reply", roomId: f.roomId, text: `好的,我安排 Compute 去${what},有进度告诉你。`, replyToSeq: f.seq },
    ];
  }
  if (f.kind === "compute") {
    if (f.signal === "milestone") return [{ kind: "reply", roomId: f.roomId, text: `进度:${f.summary}`, replyToSeq: null }];
    if (f.signal === "completed") return [{ kind: "deliver", taskId: f.taskId, text: `做完了:${f.summary}` }];
    if (f.signal === "failed") return [{ kind: "reply", roomId: f.roomId, text: `任务没做成:${f.summary}`, replyToSeq: null }];
    // 受阻:宿主已替联系人 @提出者发了提问卡(inbox 摘要里有说明)就不再重复喊,用户回答后由联系人 forward;
    // 其余受阻(如换模型被 harness 拒)照旧如实告诉用户
    if (f.signal === "blocked" && !f.summary.includes("宿主已替你在会话里")) return [{ kind: "reply", roomId: f.roomId, text: `需要你帮忙:${f.summary}`, replyToSeq: null }];
  }
  if (f.kind === "schedule") return [{ kind: "reply", roomId: f.roomId, text: `定时到了:${f.prompt}`, replyToSeq: null }];
  return [];
}

type ResumeRefusal = Refusal;

/** 剧本式 Compute:spawn 后按 script 依次吐事件;可让 spawn 失败。记录每次 spawn/resume 带来的生效模型;resumeResult 可让某次续接被拒(如换模型失败)。 */
export function scriptedCompute(
  opts: {
    script?: (computeId: string, brief: unknown) => Omit<ComputeEvent, "computeId">[];
    failSpawn?: string;
    stepMs?: number;
    resumeResult?: (computeId: string, text: string, turn: TurnModel | undefined) => ResumeRefusal | null;
    /** 续接后吐的事件(例如 harness 回报这一轮实际用过的模型)。 */
    resumeScript?: (computeId: string, turn: TurnModel | undefined) => Omit<ComputeEvent, "computeId">[];
    /** 续接后吐的事件,能看到续接带进来的文字(AC-44 回答、审查打回意见)。 */
    onResume?: (computeId: string, text: string) => Omit<ComputeEvent, "computeId">[];
    /** computeId 前缀(默认 cp);同一测试里用两个替身(执行与审查)时避免撞号。 */
    idPrefix?: string;
    /** false:扮演不声明按轮换模型能力的旧适配器(没有 capabilities)。 */
    modelAware?: boolean;
  } = {},
) {
  const queue: ComputeEvent[] = [];
  let wake: (() => void) | null = null;
  let closed = false;
  let n = 0;
  let inflight = 0;
  const spawned: { computeId: string; brief: unknown; cwd: string | undefined; model: string | undefined; effort: string | undefined }[] = [];
  const resumed: { computeId: string; text: string }[] = [];
  /** 每次被受理的续接带来的生效模型(与 resumed 一一对应);旧适配器的调用方不传就是 undefined。 */
  const turns: { computeId: string; turn: TurnModel | undefined }[] = [];
  const stopped: string[] = [];
  const push = (e: ComputeEvent) => {
    queue.push(e);
    wake?.();
  };
  const script =
    opts.script ??
    ((_id: string, brief: unknown) => [
      { kind: "started", sessionId: "s", resumed: false },
      { kind: "milestone", stage: "写文件", summary: "已写好 hello.txt" },
      { kind: "completed", result: `完成:${(brief as { task: string }).task}` },
    ]);
  const adapter = {
    capabilities: { inSessionModelSwitch: true },
    async spawn(brief: unknown, o?: { cwd?: string; model?: string; effort?: string }): Promise<SpawnResult> {
      if (opts.failSpawn) return { ok: false, reason: opts.failSpawn };
      const computeId = `${opts.idPrefix ?? "cp"}-${++n}`;
      spawned.push({ computeId, brief, cwd: o?.cwd, model: o?.model, effort: o?.effort });
      const evs = script(computeId, brief).map((e) => ({ ...e, computeId }) as ComputeEvent);
      inflight++;
      void (async () => {
        for (const e of evs) {
          await new Promise((r) => setTimeout(r, opts.stepMs ?? 1));
          push(e);
        }
        inflight--;
      })();
      return { ok: true, computeId, manifest: { computeId, sections: [], allowedTools: [], credentialRefs: [], placement: "local" } };
    },
    async resume(computeId: string, text: string, turn?: TurnModel): Promise<{ ok: true } | ResumeRefusal> {
      const refused = opts.resumeResult?.(computeId, text, turn) ?? null;
      if (refused) return refused;
      resumed.push({ computeId, text });
      turns.push({ computeId, turn });
      const evs = [...(opts.resumeScript?.(computeId, turn) ?? []), ...(opts.onResume?.(computeId, text) ?? [])].map((e) => ({ ...e, computeId }) as ComputeEvent);
      if (evs.length) {
        inflight++;
        void (async () => {
          for (const e of evs) {
            await new Promise((r) => setTimeout(r, opts.stepMs ?? 1));
            push(e);
          }
          inflight--;
        })();
      }
      return { ok: true };
    },
    async stop(computeId: string) {
      stopped.push(computeId);
      push({ computeId, kind: "stopped", code: null, signal: null, scope: "main-then-group", violations: [] });
      return { ok: true };
    },
    events() {
      return {
        [Symbol.asyncIterator]() {
          return {
            async next(): Promise<IteratorResult<ComputeEvent>> {
              while (!queue.length && !closed) await new Promise<void>((r) => (wake = r));
              wake = null;
              if (closed && !queue.length) return { done: true, value: undefined };
              return { done: false, value: queue.shift()! };
            },
          };
        },
      };
    },
    async settled() {
      return [];
    },
    snapshot: () => ({ ok: false as const, reason: "not-quiescent" }),
    rejectedReports: () => [],
  } satisfies ComputeAdapter & { capabilities: { inSessionModelSwitch: boolean } };
  if (opts.modelAware === false) Reflect.deleteProperty(adapter, "capabilities");
  return {
    adapter,
    spawned,
    resumed,
    turns,
    stopped,
    /** 所有剧本事件都已吐出且被消费。 */
    drained: () => inflight === 0 && queue.length === 0,
    close() {
      closed = true;
      wake?.();
    },
  };
}
