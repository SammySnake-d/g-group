// 测试与 CLI 演示用的确定性替身:脚本化的联系人脑子、按剧本吐语义事件的 Compute 适配器。不连模型、不起进程。
import type { ComputeActivity, ComputeAdapter, ComputeEvent, QuiesceResult, Refusal, SpawnOptions, SpawnResult, TurnModel } from "@g-group/adapter-cc-compute";
import type { ContactMind, HelperMind, HelperMindInput, Inbound, MindAction, RoundInput, RoundOutput } from "@g-group/kernel";

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
    if (f.signal === "stalled") return [{ kind: "reply", roomId: f.roomId, text: `任务卡住了:${f.summary}`, replyToSeq: null }];
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
    /** 续接后吐的事件(例如 harness 回报这一轮实际用过的模型);text 是续接内容,tools 是这次续接给的工具清单(AC-17)。 */
    resumeScript?: (computeId: string, turn: TurnModel | undefined, text: string, tools: readonly string[] | undefined) => Omit<ComputeEvent, "computeId">[];
    /** 这一轮事件还没吐完时拒绝续接,与真实适配器「这个 Compute 还在运行,等它结束这一轮再续」一致(AC-45 排队)。 */
    refuseWhileRunning?: boolean;
    /** 续接后吐的事件,能看到续接带进来的文字(AC-44 回答、审查打回意见)。 */
    onResume?: (computeId: string, text: string) => Omit<ComputeEvent, "computeId">[];
    /** computeId 前缀(默认 cp);同一测试里用两个替身(执行与审查)时避免撞号。 */
    idPrefix?: string;
    /** false:扮演不声明按轮换模型能力的旧适配器(没有 capabilities)。 */
    modelAware?: boolean;
    /** 停止确认(AC-23):给了就当作适配器的 quiesce;测试用它控制「进程什么时候真的退干净」 */
    quiesce?: (computeId: string) => Promise<QuiesceResult>;
    /** settled 之前等它(模拟 CLI 主进程退出得慢) */
    settle?: (computeId: string) => Promise<void>;
    /** 和真实一次性适配器一样:这一轮已经以 completed/failed 结束的实例,stop 返回拒绝(没有在运行的进程),不再报 stopped */
    refuseStopAfterExit?: boolean;
  } = {},
) {
  const queue: ComputeEvent[] = [];
  let wake: (() => void) | null = null;
  const acts: ComputeActivity[] = [];
  let actWake: (() => void) | null = null;
  let closed = false;
  let n = 0;
  let inflight = 0;
  const spawned: { computeId: string; brief: unknown; cwd: string | undefined; model: string | undefined; effort: string | undefined; opts: SpawnOptions | undefined }[] = [];
  /** 续接记录;续接换了工具清单(宿主按授权放开或收回写工具,AC-17)时才带 tools */
  const resumed: { computeId: string; text: string; tools?: readonly string[] }[] = [];
  /** 每个实例这一轮还没吐完的事件批数(refuseWhileRunning 用) */
  const busy = new Map<string, number>();
  /** 每个实例当前的工具清单 */
  const toolsOf = new Map<string, string>();
  /** 每次被受理的续接带来的生效模型(与 resumed 一一对应);旧适配器的调用方不传就是 undefined。 */
  const turns: { computeId: string; turn: TurnModel | undefined }[] = [];
  const stopped: string[] = [];
  const ended = new Set<string>();
  const push = (e: ComputeEvent) => {
    if (e.kind === "completed" || e.kind === "failed") ended.add(e.computeId);
    if (e.kind === "started") ended.delete(e.computeId);
    queue.push(e);
    wake?.();
  };
  const play = (computeId: string, evs: ComputeEvent[]) => {
    if (!evs.length) return;
    inflight++;
    busy.set(computeId, (busy.get(computeId) ?? 0) + 1);
    void (async () => {
      for (const e of evs) {
        await new Promise((r) => setTimeout(r, opts.stepMs ?? 1));
        push(e);
      }
      busy.set(computeId, (busy.get(computeId) ?? 1) - 1);
      inflight--;
    })();
  };
  const script =
    opts.script ??
    ((_id: string, brief: unknown) => [
      { kind: "started", sessionId: "s", resumed: false },
      { kind: "milestone", stage: "写文件", summary: "已写好 hello.txt" },
      { kind: "completed", result: `完成:${(brief as { task: string }).task}` },
    ]);
  const adapter = {
    capabilities: { inSessionModelSwitch: true, isolation: true },
    async spawn(brief: unknown, o?: { cwd?: string; model?: string; effort?: string }): Promise<SpawnResult> {
      if (opts.failSpawn) return { ok: false, reason: opts.failSpawn };
      const computeId = `${opts.idPrefix ?? "cp"}-${++n}`;
      spawned.push({ computeId, brief, cwd: o?.cwd, model: o?.model, effort: o?.effort, opts: o });
      toolsOf.set(computeId, JSON.stringify((brief as { tools?: unknown }).tools ?? null));
      play(computeId, script(computeId, brief).map((e) => ({ ...e, computeId }) as ComputeEvent));
      return { ok: true, computeId, manifest: { computeId, sections: [], allowedTools: [], credentialRefs: [], placement: "local" } };
    },
    async resume(computeId: string, text: string, turn?: TurnModel, o?: { readonly tools?: readonly string[] }): Promise<{ ok: true } | ResumeRefusal> {
      if (opts.refuseWhileRunning && (busy.get(computeId) ?? 0) > 0) return { ok: false, reason: "这个 Compute 还在运行,等它结束这一轮再续" };
      const refused = opts.resumeResult?.(computeId, text, turn) ?? null;
      if (refused) return refused;
      const changed = o?.tools !== undefined && JSON.stringify(o.tools) !== toolsOf.get(computeId);
      if (o?.tools) toolsOf.set(computeId, JSON.stringify(o.tools));
      resumed.push({ computeId, text, ...(changed && o?.tools ? { tools: [...o.tools] } : {}) });
      turns.push({ computeId, turn });
      play(computeId, [...(opts.resumeScript?.(computeId, turn, text, o?.tools) ?? []), ...(opts.onResume?.(computeId, text) ?? [])].map((e) => ({ ...e, computeId }) as ComputeEvent));
      return { ok: true };
    },
    async stop(computeId: string) {
      if (opts.refuseStopAfterExit && ended.has(computeId)) return { ok: false as const, reason: `Compute ${computeId} 没有在运行的进程` };
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
    async settled(computeId) {
      await opts.settle?.(computeId);
      return [];
    },
    ...(opts.quiesce ? { quiesce: opts.quiesce } : {}),
    snapshot: () => ({ ok: false as const, reason: "not-quiescent" }),
    rejectedReports: () => [],
    activity() {
      return {
        [Symbol.asyncIterator]() {
          return {
            async next(): Promise<IteratorResult<ComputeActivity>> {
              while (!acts.length && !closed) await new Promise<void>((r) => (actWake = r));
              actWake = null;
              if (closed && !acts.length) return { done: true, value: undefined };
              return { done: false, value: acts.shift()! };
            },
          };
        },
      };
    },
  } satisfies ComputeAdapter & { capabilities: { inSessionModelSwitch: boolean } };
  if (opts.modelAware === false) Reflect.deleteProperty(adapter, "capabilities");
  return {
    adapter,
    spawned,
    resumed,
    turns,
    stopped,
    /** 所有剧本事件都已吐出且被消费。 */
    /** 这个实例此刻生效的工具清单(派发时的 brief,或最近一次续接换上的)。 */
    currentTools: (computeId: string): string[] => JSON.parse(toolsOf.get(computeId) ?? "null") ?? [],
    drained: () => inflight === 0 && queue.length === 0 && acts.length === 0,
    /** 按需补发一条语义事件(剧本之外,测试用) */
    emit(e: ComputeEvent) {
      push(e);
    },
    /** 模拟 harness 流里的活动(卡死检测用) */
    pushActivity(a: ComputeActivity) {
      acts.push(a);
      actWake?.();
    },
    close() {
      closed = true;
      wake?.();
      actWake?.();
    },
  };
}

/**
 * Helper 的规则替身(开发前端与 CLI 演示用,不连模型):只认三种说法,其余如实说听不懂。工具经 Helper MCP(tools/call)照常真执行。
 *   「建个群叫 X,拉 A 和 B 进来」→ contacts_list 查 id → rooms_createGroup;
 *   「把 A 删掉」→ 照 skill 先问用户、不调工具;用户下一句说「同意」(此前对话里有这个问题)→ contacts_remove;
 *   「…CSV…:」后跟 CSV 原文(侧栏 / @ 入口)→ tasks_importCsv 到当前聊天。
 */
export function scriptedHelperMind(opts: { onRun?: (input: HelperMindInput) => void } = {}): HelperMind {
  return {
    async run(input, _signal, mcp) {
      opts.onRun?.(input);
      const calls: { name: string; args: unknown; ok: boolean; text: string }[] = [];
      const call = async (name: string, args: unknown) => {
        const r = (await mcp.request("tools/call", { name, arguments: args })) as { content: { text: string }[]; isError: boolean };
        const out = { ok: !r.isError, text: r.content.map((c) => c.text).join("") };
        calls.push({ name, args, ...out });
        return out;
      };
      const contactIds = async (names: string[]) => {
        const r = await call("contacts_list", {});
        const list = r.ok ? (JSON.parse(r.text) as { contacts: { id: string; name: string }[] }).contacts : [];
        return names.map((n) => ({ name: n, id: list.find((c) => c.name === n)?.id ?? null }));
      };
      const t = input.text.trim();
      const group = /建(?:个|一个)?群(?:叫|名叫|名字叫)?\s*「?([^,，。」\s]+)」?.*?拉(.+?)进来/.exec(t);
      if (group) {
        const found = await contactIds(group[2]!.split(/[和、,，\s]+/).map((x) => x.trim()).filter(Boolean));
        const missing = found.filter((f) => !f.id).map((f) => f.name);
        if (missing.length) return { reply: `没找到联系人:${missing.join("、")}`, calls };
        const r = await call("rooms_createGroup", { title: group[1], members: found.map((f) => ({ kind: "contact", id: f.id })) });
        return { reply: r.ok ? `建好了群「${group[1]}」,拉了 ${found.map((f) => f.name).join("、")}` : `没建成:${r.text}`, calls };
      }
      const remove = /^把(.+?)删掉/.exec(t);
      if (remove) return { reply: `要删除联系人「${remove[1]!.trim()}」吗?删了不能恢复。回复「同意」我就删。`, calls };
      const asked = /^(同意|可以|确认)/.test(t) ? [...input.history].reverse().find((h) => h.role === "helper")?.text.match(/要删除联系人「(.+?)」吗/) : null;
      if (asked) {
        const [f] = await contactIds([asked[1]!]);
        if (!f?.id) return { reply: `没找到联系人:${asked[1]}`, calls };
        const r = await call("contacts_remove", { contactId: f.id });
        return { reply: r.ok ? `删掉了联系人「${f.name}」` : `没删成:${r.text}`, calls };
      }
      const csv = /csv[^:：]*[:：]\s*([\s\S]+)$/i.exec(t);
      if (csv && input.route.contextRoomId) {
        const r = await call("tasks_importCsv", { roomId: input.route.contextRoomId, csv: csv[1] });
        if (!r.ok) return { reply: `没导入:${r.text}`, calls };
        const v = JSON.parse(r.text) as { tasks: unknown[]; errors: { line: number; reason: string }[] };
        return { reply: `导入了 ${v.tasks.length} 个任务${v.errors.length ? `,${v.errors.length} 行有问题:${v.errors.map((e) => `第 ${e.line} 行 ${e.reason}`).join(";")}` : ""}`, calls };
      }
      return { reply: "我是规则替身,只认:建群拉人、删联系人、CSV 转任务。", calls };
    },
  };
}
