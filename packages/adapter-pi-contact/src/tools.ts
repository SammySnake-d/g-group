// 联系人的直接工具清单:每种 MindAction 一个工具,外加 update_state_note 与只读的 read_memory(经宿主给的本轮查询口取全文)。
// 工具只校验参数形状、登记成 MindAction 并立即回「已登记」,不做任何 I/O;
// 宿主在本轮结束后逐条校验(会话可见、任务归属、seq 在本轮输入里)、分配 action_id、落盘后才执行(runtime-ports.ts)。
// 清单是封闭的:联系人没有 shell、文件读写、网络这类工具;要动手就用 dispatch_compute 开 Compute(AC-33)。
import type { MindAction } from "@g-group/kernel";

/** 工具名 → 对应的动作种类;update_state_note 不是动作,写进 RoundOutput.stateNote。 */
export const PI_CONTACT_TOOL_NAMES = Object.freeze([
  "reply",
  "dispatch_compute",
  "commit",
  "forward",
  "deliver",
  "stop",
  "verdict",
  "update_state_note",
  "remember",
  "memory_feedback",
  "read_memory",
  "read_quote_parent",
  "progress_rerun",
] as const);
export type PiContactToolName = (typeof PI_CONTACT_TOOL_NAMES)[number];

type FieldKind = "text" | "seq" | "seqOrNull" | "textOrNull" | "verdict" | "texts" | "bool" | "relationOrNull";
interface FieldSpec {
  readonly kind: FieldKind;
  readonly required: boolean;
  readonly description: string;
}
interface ToolSpec {
  readonly description: string;
  readonly fields: Readonly<Record<string, FieldSpec>>;
}

const RELATIONS = ["change", "refine", "conflict"] as const;
const f = (kind: FieldKind, required: boolean, description: string): FieldSpec => ({ kind, required, description });

const SPECS: Readonly<Record<PiContactToolName, ToolSpec>> = Object.freeze({
  reply: {
    description: "在会话里发言。只有通过这个工具说的话才会发到会话里;直接输出的文字不会发给任何人。宿主校验后才真正发出。",
    fields: {
      roomId: f("text", true, "会话 id(群或私聊),必须是本轮新消息所在的会话"),
      text: f("text", true, "要发出的原文"),
      replyToSeq: f("seqOrNull", false, "回复哪条消息的 seq;不针对某条消息就省略"),
    },
  },
  dispatch_compute: {
    description: "开一个 Compute 去干活(写文件、跑命令、改代码、长时间任务都走这里;你自己没有 shell 和文件工具)。宿主建任务并异步启动,结果之后以事件回到你这里。",
    fields: {
      roomId: f("text", true, "任务来源的会话 id"),
      sourceSeq: f("seq", true, "提出这件事的那条消息的 seq"),
      title: f("text", true, "任务短名"),
      task: f("text", true, "交给 Compute 的完整说明:要做什么、完成判据、约束"),
    },
  },
  commit: {
    description: "登记一条承诺(你答应要做的事)。text 必须是来源消息或你本轮 reply 里的原文片段。",
    fields: {
      roomId: f("text", true, "承诺所在的会话 id"),
      sourceSeq: f("seq", true, "引出这条承诺的消息 seq"),
      text: f("text", true, "承诺原文片段"),
      taskId: f("textOrNull", false, "关联的任务 id;还没有任务就省略"),
      everyNMessages: f("seqOrNull", false, "用户要你「每 N 条消息做一次」(例如每 100 条总结一次)时填 N;宿主替你数这个会话的消息,到点把那一段交给你。不是这类承诺就省略"),
    },
  },
  forward: {
    description: "把用户追加的要求或回答转给在途的 Compute(续接)。",
    fields: {
      taskId: f("text", true, "在途任务 id"),
      text: f("text", true, "要转交的原文"),
      sourceSeq: f("seqOrNull", false, "这段转交出自任务所在会话里哪条用户消息的 seq;是用户中途补充或改条件时必填,宿主据此给任务升版并登记;只是你自己的话就省略"),
    },
  },
  deliver: {
    description: "交付任务结果,等用户确认。",
    fields: {
      taskId: f("text", true, "任务 id"),
      text: f("text", true, "交付说明"),
    },
  },
  stop: {
    description: "请求停止某个任务的 Compute。",
    fields: {
      taskId: f("text", true, "任务 id"),
    },
  },
  verdict: {
    description: "记下提出者对你交付的回复:他明确说通过用 accept,他说要改用 revise 并带上原话。只认他本人在交付之后发的消息;没回复就一直等,不要自己当作通过。宿主核对来源后才生效。",
    fields: {
      taskId: f("text", true, "被验收的任务 id"),
      sourceSeq: f("seq", true, "用户表达通过或修改意见的那条消息的 seq(必须是提出者本人在交付之后发的)"),
      verdict: f("verdict", true, "accept:用户明确说通过;revise:用户要改"),
      feedback: f("textOrNull", false, "revise 时用户要改什么(原话);accept 省略"),
    },
  },
  progress_rerun: {
    description:
      "重跑运行台账(第 5 块「运行台账」)里失败、中断或没跑完的单元。自己名下的可以自己决定重跑,有次数上限;别人名下的只有本轮有人明确要求时才能重跑,basisSeq 写那条要求的消息,宿主会在群里留记录。人停的不能自动重跑。",
    fields: {
      runId: f("text", true, "台账里单元的 id"),
      roomId: f("text", true, "在哪个会话里发起(决定你能看到哪些单元)"),
      basisSeq: f("seqOrNull", false, "本轮里明确要求重跑的那条消息的 seq;自己决定重跑就省略"),
    },
  },
  remember: {
    description: "记下一条以后用得上的记忆(D25):用户的偏好与纠正、定下的规矩、走通或走不通的做法。写下立即生效。先看第 5 块与前缀里已有的记忆:内容相同就不必再记;改变了某条旧结论就填 relation=change 与 target;只是补充细节填 refine;和某条用户原话矛盾填 conflict(宿主会请用户拍板)。",
    fields: {
      roomId: f("text", true, "记忆来源的会话 id"),
      sourceSeq: f("seqOrNull", false, "来源消息 seq;没有具体来源就省略"),
      title: f("text", true, "一句话标题"),
      text: f("text", true, "记忆正文:以后要照做或要避开的事实"),
      anchors: f("texts", true, "适用范围锚点:room:<会话id>、user:<uid>、task:<任务id>、tool:<工具名>、path:<路径>、module:<模块>;用户明确说了「以后都/所有」才用 global"),
      quote: f("textOrNull", false, "来源用户消息里的原话片段(逐字);不是用户原话就省略"),
      relation: f("relationOrNull", false, "与已有记忆的关系:change 改变 / refine 细化 / conflict 冲突;新增就省略"),
      target: f("textOrNull", false, "relation 指向的记忆 id"),
    },
  },
  memory_feedback: {
    description: "记一笔某条记忆这次用得好不好(用后反馈,不是门槛)。同一条连续几次不好会被降级排后。",
    fields: {
      id: f("text", true, "记忆 id"),
      good: f("bool", true, "这次照它做,结果好不好"),
      note: f("textOrNull", false, "一句话说明"),
    },
  },
  read_memory: {
    description: "按 id 读一条记忆的全文与状态(第 5 块里只给了标题的那些)。结果直接作为工具结果返回。",
    fields: {
      id: f("text", true, "记忆 id"),
    },
  },
  read_quote_parent: {
    description: "引用链往上读一级(D24):返回这条消息直接引用的那几条,每条标明状态和还有没有上一级。第 5 块引用链里标了 has_more_above、而你还没看懂时再用;一次只给一级。",
    fields: {
      roomId: f("text", true, "会话 id"),
      seq: f("seq", true, "要往上读的那条消息的 seq"),
    },
  },
  update_state_note: {
    description: "写新的状态笔记(下一轮第 3 块):当前在做什么、下一步、完成判据、相关指针、走不通的路;不复述过程。本轮多次调用以最后一次为准。",
    fields: {
      note: f("text", true, "完整的新状态笔记"),
    },
  },
});

const schemaOf = (s: FieldSpec): Record<string, unknown> => {
  switch (s.kind) {
    case "text": return { type: "string", minLength: 1, description: s.description };
    case "textOrNull": return { type: ["string", "null"], minLength: 1, description: s.description };
    case "seq": return { type: "integer", minimum: 0, description: s.description };
    case "seqOrNull": return { type: ["integer", "null"], minimum: 0, description: s.description };
    case "verdict": return { type: "string", enum: ["accept", "revise"], description: s.description };
    case "texts": return { type: "array", items: { type: "string", minLength: 1 }, minItems: 1, description: s.description };
    case "bool": return { type: "boolean", description: s.description };
    case "relationOrNull": return { type: ["string", "null"], enum: [...RELATIONS, null], description: s.description };
  }
};

/** 发给模型的工具声明(JSON Schema)。按 PI_CONTACT_TOOL_NAMES 顺序。 */
export interface ToolDeclaration {
  readonly name: PiContactToolName;
  readonly description: string;
  readonly parameters: Readonly<Record<string, unknown>>;
}
export const TOOL_DECLARATIONS: readonly ToolDeclaration[] = Object.freeze(
  PI_CONTACT_TOOL_NAMES.map((name) => {
    const spec = SPECS[name];
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [k, s] of Object.entries(spec.fields)) {
      properties[k] = schemaOf(s);
      if (s.required) required.push(k);
    }
    return Object.freeze({ name, description: spec.description, parameters: { type: "object", properties, required, additionalProperties: false } });
  }),
);

/** 一次工具调用登记成什么:动作,或新的状态笔记。 */
export type Registered =
  | { readonly kind: "action"; readonly action: MindAction }
  | { readonly kind: "note"; readonly note: string }
  | { readonly kind: "read"; readonly id: string }
  | { readonly kind: "read-quote"; readonly roomId: string; readonly seq: number };
export type ParseResult = { readonly ok: true; readonly value: Registered } | { readonly ok: false; readonly why: string };

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

/**
 * 校验一次工具调用的参数形状并登记。只看形状:字段齐全、没有多余字段、文本非空白、seq 是非负安全整数;
 * 可省略的字段省略或给 null 都记成 null。语义(会话是否可见、seq 是否在本轮、任务归属)留给宿主。
 */
export function parseToolCall(name: string, args: unknown): ParseResult {
  if (!(PI_CONTACT_TOOL_NAMES as readonly string[]).includes(name)) return { ok: false, why: `没有叫 ${name} 的工具` };
  const tool = name as PiContactToolName;
  const spec = SPECS[tool];
  if (!isRecord(args)) return { ok: false, why: "参数必须是一个对象" };
  const problems: string[] = [];
  for (const k of Object.keys(args)) if (!Object.hasOwn(spec.fields, k)) problems.push(`多余字段 ${k}`);
  const v: Record<string, string | number | boolean | readonly string[] | null> = {};
  for (const [k, s] of Object.entries(spec.fields)) {
    const x = Object.hasOwn(args, k) ? args[k] : undefined;
    if (x === undefined || x === null) {
      if (s.required) problems.push(`缺字段 ${k}`);
      else v[k] = null;
      continue;
    }
    if (s.kind === "verdict") {
      if (x !== "accept" && x !== "revise") problems.push(`${k} 只能是 accept 或 revise`);
      else v[k] = x;
    } else if (s.kind === "texts") {
      if (!Array.isArray(x) || x.length === 0 || !x.every((y) => typeof y === "string" && y.trim() !== "")) problems.push(`${k} 必须是非空字符串组成的非空数组`);
      else v[k] = Object.freeze([...x] as string[]);
    } else if (s.kind === "bool") {
      if (typeof x !== "boolean") problems.push(`${k} 必须是布尔值`);
      else v[k] = x;
    } else if (s.kind === "relationOrNull") {
      if (!(RELATIONS as readonly unknown[]).includes(x)) problems.push(`${k} 只能是 ${RELATIONS.join(" / ")}`);
      else v[k] = x as string;
    } else if (s.kind === "text" || s.kind === "textOrNull") {
      if (typeof x !== "string") problems.push(`${k} 必须是字符串`);
      else if (x.trim() === "") problems.push(`${k} 不能为空白`);
      else v[k] = x;
    } else if (typeof x !== "number" || !Number.isSafeInteger(x) || x < 0) {
      problems.push(`${k} 必须是非负整数`);
    } else {
      v[k] = x;
    }
  }
  if (problems.length > 0) return { ok: false, why: problems.join(";") };
  const s = (k: string) => v[k] as string;
  const n = (k: string) => v[k] as number;
  const sn = (k: string) => v[k] as string | null;
  const nn = (k: string) => v[k] as number | null;
  switch (tool) {
    case "reply": return act({ kind: "reply", roomId: s("roomId"), text: s("text"), replyToSeq: nn("replyToSeq") });
    case "dispatch_compute": return act({ kind: "dispatch", roomId: s("roomId"), sourceSeq: n("sourceSeq"), title: s("title"), task: s("task") });
    case "commit": {
      const every = nn("everyNMessages");
      return act({ kind: "commit", roomId: s("roomId"), sourceSeq: n("sourceSeq"), text: s("text"), taskId: sn("taskId"), ...(every !== null ? { everyNMessages: every } : {}) });
    }
    case "forward": {
      const src = nn("sourceSeq");
      return act({ kind: "forward", taskId: s("taskId"), text: s("text"), ...(src !== null ? { sourceSeq: src } : {}) });
    }
    case "deliver": return act({ kind: "deliver", taskId: s("taskId"), text: s("text") });
    case "stop": return act({ kind: "stop", taskId: s("taskId") });
    case "verdict": return act({ kind: "verdict", taskId: s("taskId"), sourceSeq: n("sourceSeq"), verdict: s("verdict") as "accept" | "revise", feedback: sn("feedback") });
    case "progress_rerun": return act({ kind: "rerun", runId: s("runId"), roomId: s("roomId"), basisSeq: nn("basisSeq") });
    case "update_state_note": return { ok: true, value: { kind: "note", note: s("note") } };
    case "remember":
      return act({ kind: "remember", roomId: s("roomId"), sourceSeq: nn("sourceSeq"), title: s("title"), text: s("text"), anchors: v.anchors as readonly string[], quote: sn("quote"), relation: sn("relation") as "change" | "refine" | "conflict" | null, target: sn("target") });
    case "memory_feedback": return act({ kind: "memory-use", id: s("id"), good: v.good as boolean, note: sn("note") });
    case "read_memory": return { ok: true, value: { kind: "read", id: s("id") } };
    case "read_quote_parent": return { ok: true, value: { kind: "read-quote", roomId: s("roomId"), seq: n("seq") } };
  }
}
const act = (action: MindAction): ParseResult => ({ ok: true, value: { kind: "action", action: Object.freeze(action) } });
