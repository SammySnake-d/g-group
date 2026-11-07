// Each mutant is applied to a fresh copy. A named test must fail; a load error is not a kill.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const source = path.resolve(import.meta.dirname, "../src");
const target = "commitment-ledger.ts";
const mutants = [
  ["M01 未接收返回错误原因", 'if (!m) return fail("message-not-found");', 'if (!m) return fail("invalid-input");', "未收到的消息不能处理或生成承诺"],
  ["M02 重试丢失幂等性", "if (previous) return previous.payload === payload", "if (false && previous) return previous.payload === payload", "同一投递动作重试按稳定 id 去重,旧版本重试也不重复"],
  ["M03 相同动作号允许不同内容", "previous.payload === payload ?", "true ?", "复用动作 id 改载荷会被拒绝"],
  ["M04 同消息号的冲突被吞掉", 'if (canonical(prior as unknown as Json) !== canonical(m as unknown as Json)) return fail("message-id-conflict");', 'if (false) return fail("message-id-conflict");', "同一消息 id 重投不重复,但内容冲突不得覆盖"],
  ["M05 删除版本检查", 'if (state.version !== expectedVersion) return fail("version-conflict");', "", "新动作使用旧版本被拒绝且不改原状态"],
  ["M06 未接下也登记", 'if (m.sender.kind === "user" && !input.accepted && input.commitments.length) return fail("not-accepted");', "", "用户未接下的要求不能伪造承诺"],
  ["M07 覆盖同名承诺", 'if (new Set(ids).size !== ids.length || ids.some((id) => commitments.some((c) => c.id === id))) return fail("commitment-id-conflict");', "", "同 id 承诺不可覆盖,失败不得部分处理消息"],
  ["M08 新消息冲掉旧承诺", "messages.push({ ...m, handled: false });", "messages.push({ ...m, handled: false }); commitments = [];", "后台等待的承诺不因后续消息或时间样式字段自动消失"],
  ["M09 登记后不标记消息", "entry.seq === m.seq ? { ...entry, handled: true } : entry", "entry", "用户交办并接下的多个承诺同时登记并保留来源"],
  ["M10 不检查产物存在", 'if (!exists) return fail("artifact-not-found");', "", "done 没有存在的产物不得落账"],
  ["M11 允许修改终态", 'if (current.status !== "active") return fail("commitment-closed");', "", "已了结承诺不能再次改成其他状态"],
  ["M12 Compute 直接发言", 'if (m.sender.kind === "compute") return fail("sender-not-allowed");', "", "Compute 不得直接作为群消息发送者"],
  ["M13 跨任务更新承诺", 'if (current.taskId !== input.taskId) return fail("task-mismatch");', "", "Compute 只可报告绑定任务的承诺进展,不能了结承诺"],
  ["M14 Compute 直接了结承诺", 'if (input.actor.kind === "compute" || (input.actor.kind === "contact"', 'if ((input.actor.kind === "contact"', "Compute 只可报告绑定任务的承诺进展,不能了结承诺"],
  ["M15 引用补充串任务", 'if (parent.taskId !== m.taskId) return fail("task-mismatch");', "", "引用审查汇报的补充不能绑到快捷键任务"],
  ["M16 其他轮次动作冒充本轮", "a.roundId === roundId && a.commitmentId === id", "a.commitmentId === id", "本轮有动作后对账通过,别轮动作不冒充本轮动作"],
  ["M17 所有后台承诺阻塞闲聊", "const pending = ids.filter((id) => {", "const pending = state.commitments.map((c) => c.id).filter((id) => {", "轮末只对本轮绑定承诺对账,后台任务不阻塞闲聊"],
  ["M18 重投不保留动作身份", "const repeat: Ledger = { ...state, version: state.version + 1, actions: [...state.actions, { id: input.actionId, payload }] };", "const repeat: Ledger = state;", "同一消息 id 重投不重复,但内容冲突不得覆盖"],
  ["M19 承诺文字脱离来源原文", 'if (input.commitments.some((c) => !m.text.includes(c.text))) return fail("commitment-text-not-source");', "", "用户交办并接下的多个承诺同时登记并保留来源"],
  ["M20 未绑定 Compute 记进展", ' ||\n            (input.actor.kind === "compute" && input.actor.id !== current.computeId)', "", "未绑定的 Compute 不可记进展,对账仍待处理"],
  ["M21 非主人可绑定", 'if (input.actor.kind !== "contact" || input.actor.id !== state.ownerId) return fail("actor-not-allowed");', "", "只有账本主人可绑定 Compute,绑定遵循版本和动作幂等"],
  ["M22 绑定冒充本轮进展", 'commitments = commitments.map((c) => c.id === current.id ? { ...c, computeId: input.computeId } : c);', 'commitments = commitments.map((c) => c.id === current.id ? { ...c, computeId: input.computeId } : c); activity.push({ roundId: "r1", commitmentId: current.id, taskId: current.taskId, actor: input.actor, kind: "progress", text: null });', "主人可绑定、替换和撤销 Compute,仅当前绑定可记进展"],
  ["M23 无法撤销绑定", 'computeId: input.computeId } : c)', 'computeId: input.computeId ?? c.computeId } : c)', "主人可绑定、替换和撤销 Compute,仅当前绑定可记进展"],
  ["M24 绑定波及其他承诺", 'commitments = commitments.map((c) => c.id === current.id ? { ...c, computeId: input.computeId } : c);', 'commitments = commitments.map((c) => ({ ...c, computeId: input.computeId }));', "绑定范围限于对应承诺且拒绝无效或终态输入"],
  ["M25 绑定接受空身份", 'text(x.commitmentId) && text(x.taskId) && actor(x.actor) && maybeText(x.computeId);', 'text(x.commitmentId) && text(x.taskId) && actor(x.actor) && (x.computeId === null || typeof x.computeId === "string");', "绑定范围限于对应承诺且拒绝无效或终态输入"],
  ["M26 接收消息直接标为已处理", 'messages.push({ ...m, handled: false });', 'messages.push({ ...m, handled: true });', "收到消息时先记录原文、序号和未处理状态"],
  ["M27 主人消息不能登记", 'm.sender.kind === "contact" && m.sender.id !== state.ownerId && input.commitments.length', 'm.sender.kind === "contact" && input.commitments.length', "联系人自己说出的承诺进自己的账本"],
  ["M28 存在的产物被拒绝", 'artifactExists(input.artifact) === true', 'artifactExists(input.artifact) === false', "可信产物解析器确认存在后才可完成,并保留指针"],
  ["M29 了结时删除承诺", 'commitments = commitments.map((c) => c.id === current.id ? { ...c, status: input.outcome, resolution: { artifact: input.artifact, detail: input.detail } } : c);', 'commitments = commitments.filter((c) => c.id !== current.id);', "撤销、替代和阻塞必须明确记录而不是删除"],
  ["M30 顶层 Proxy 被探测", ' || types.isProxy(value)', '', "拒绝 getter、setter 和 Proxy,不触发其代码"],
  ["M31 空所有者返回错误原因", 'if (!text(ownerId)) return fail("invalid-input");', 'if (!text(ownerId)) return fail("invalid-owner");', "合法 JSON 的 null 输入被拒绝但不抛异常"],
  ["M32 嵌套 Proxy 被探测", ' || types.isProxy(value)', '', "嵌套访问器与 Proxy 在三个入口均不执行"],
  ["M33 拒绝合法的空任务", 'text(x.text) && maybeText(x.taskId) &&', 'text(x.text) && text(x.taskId) &&', "各入口的 null 输入不抛错,合法 null 字段可接受"],
  ["M34 返回快照不冻结", 'Object.freeze(value);', '', "返回账本深冻结且不冻结调用方输入"],
  ["F01 非主人联系人可记进展", '(input.actor.kind === "contact" && input.actor.id !== state.ownerId) ||\n            (input.actor.kind === "compute"', '(input.actor.kind === "compute"', "非主人联系人不得记进展"],
  ["F02 非主人联系人可了结", 'if (input.actor.kind === "compute" || (input.actor.kind === "contact" && input.actor.id !== state.ownerId) ||', 'if (input.actor.kind === "compute" ||', "非主人联系人不得了结承诺"],
  ["F03 用户可直接了结", '(input.actor.kind === "user" && input.outcome !== "revoked")) return fail("actor-not-allowed");', 'false) return fail("actor-not-allowed");', "用户不得直接完成、替代或阻塞承诺"],
  ["F04 用户可记进展", 'if (input.actor.kind === "user" || (input.actor.kind === "contact"', 'if ((input.actor.kind === "contact"', "用户不得记承诺进展"],
  ["F05 其他联系人消息可登记", 'if (m.sender.kind === "contact" && m.sender.id !== state.ownerId && input.commitments.length) return fail("actor-not-allowed");', "", "其他联系人的消息不能登记到主人账本"],
  ["F06 来源任务可串线", 'if (input.commitments.some((c) => m.taskId !== null && c.taskId !== m.taskId)) return fail("task-mismatch");', "", "承诺不得绑定到来源消息以外的任务"],
  ["F07 终态仍可进展", 'if (current.status !== "active") return fail("commitment-closed");', 'if (input.type === "close" && current.status !== "active") return fail("commitment-closed");', "撤销后的承诺不得再记进展"],
  ["F08 非 false 即算产物存在", "artifactExists(input.artifact) === true", "artifactExists(input.artifact) !== false", "产物解析器返回非布尔真值不算存在"],
  ["F09 解析器异常外泄", 'try { exists = !!input.artifact && typeof artifactExists === "function" && !types.isProxy(artifactExists) && artifactExists(input.artifact) === true; } catch { /* unresolved is not completion */ }', 'exists = !!input.artifact && typeof artifactExists === "function" && !types.isProxy(artifactExists) && artifactExists(input.artifact) === true;', "产物解析器抛错按不存在处理"],
  ["F10 对账忽略终态", 'return c.status === "active" && !state.activity', 'return !state.activity', "别轮已完成的承诺不再挂起"],
  ["F11 快照不校验来源", 'm.seq === c.sourceSeq && m.handled && m.text.includes(c.text)', 'm.seq === c.sourceSeq && m.handled', "篡改承诺来源的外部账本被拒绝"],
  ["F12 快照不校验终态产物", '(c.status === "done" ? text(c.resolution.artifact) : text(c.resolution.detail)))) &&', 'true)) &&', "完成却缺少产物的外部账本被拒绝"],
  ["F13 幂等依赖键序", 'Object.keys(value).sort().map', 'Object.keys(value).map', "相同动作载荷键序不同仍幂等"],
  ["F14 外部类实例被接收", 'if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) throw new TypeError("invalid prototype");', "", "外部类实例命令被拒绝"],
  ["F15 接受未来版本", 'if (state.version !== expectedVersion)', 'if (state.version > expectedVersion)', "未来版本号不得提交"],
  ["F16 终态不要求原因", '} else if (!input.detail || input.artifact !== null) return fail("resolution-required");', '}', "撤销、替代和阻塞缺原因或带产物均被拒绝"],
  ["F17 接收不存在的引用", 'if (!parent) return fail("reply-not-found");', 'if (!parent) { messages.push({ ...m, handled: false }); } else', "引用不存在的消息被拒绝"],
  ["F18 重复处理消息", 'if (m.handled) return fail("already-processed");', "", "已处理消息不得使用新动作号重复处理"],
  ["F19 对账不拒未知承诺", 'if (ids.some((id) => !state.commitments.some((c) => c.id === id))) return { ok: false, reason: "commitment-not-found" };', "", "对账拒绝不存在的承诺"],
  ["F20 接收重复序号", 'if (messages.some((entry) => entry.seq === m.seq)) return fail("seq-conflict");', "", "不同消息不能复用序号"],
];

// Each marker must occur in the designated test's own diagnostic, not elsewhere in the run.
const diagnostics = {
  M01: "message-not-found", M02: "false !== true", M03: "action-id-conflict", M04: "message-id-conflict",
  M05: "version-conflict", M06: "not-accepted", M07: "commitment-id-conflict", M08: "active",
  M09: "false !== true", M10: "artifact-not-found", M11: "commitment-closed", M12: "sender-not-allowed",
  M13: "task-mismatch", M14: "actor-not-allowed", M15: "task-mismatch", M16: "pending", M17: "pending",
  M18: "action-id-conflict", M19: "commitment-text-not-source", M20: "actor-not-allowed",
  M21: "actor-not-allowed", M22: "pending", M23: "actor-not-allowed", M24: "actor-not-allowed", M25: "invalid-input",
  M26: "false", M27: "我会做", M28: "false !== true", M29: "revoked", M30: "1 !== 0",
  M31: "invalid-input", M32: "!== 0", M33: "false !== true", M34: "false !== true",
  F01: "actor-not-allowed", F02: "actor-not-allowed", F03: "actor-not-allowed", F04: "actor-not-allowed",
  F05: "actor-not-allowed", F06: "task-mismatch", F07: "commitment-closed", F08: "artifact-not-found",
  F09: "unavailable", F10: "pending", F11: "invalid-input", F12: "invalid-input", F13: "false !== true",
  F14: "invalid-input", F15: "version-conflict", F16: "resolution-required", F17: "reply-not-found",
  F18: "already-processed", F19: "Cannot read properties of undefined", F20: "seq-conflict",
};

// Independent criteria have their own named mutation and the same unmodified-input control.
const original = (id) => {
  const match = mutants.find(([name]) => name.startsWith(`${id} `));
  if (!match) throw new Error(`missing original mutation ${id}`);
  return [match[1], match[2]];
};
const inherited = (name, id, criterion, marker) => [name, ...original(id), criterion, marker];
const criteria = [
  ["C01 接收错写消息编号", 'messages.push({ ...m, handled: false });', 'messages.push({ ...m, id: `${m.id}-wrong`, handled: false });', "接收保留消息编号", "m1-wrong"],
  ["C02 接收错写序号", 'messages.push({ ...m, handled: false });', 'messages.push({ ...m, seq: m.seq + 1, handled: false });', "接收保留消息序号", "+   2"],
  ["C03 接收错写原文", 'messages.push({ ...m, handled: false });', 'messages.push({ ...m, text: `${m.text}-wrong`, handled: false });', "接收保留消息原文", "wrong"],
  inherited("C04 提前标处理", "M26", "接收不提前标记已处理", "true"),
  ["C05 新动作重投未标重复", 'return { ok: true, ledger: freeze(repeat), duplicate: true };', 'return { ok: true, ledger: freeze(repeat), duplicate: false };', "同消息新动作重投标记重复", "false !== true"],
  inherited("C06 重投丢失新动作身份", "M18", "同消息新动作重投保留新动作身份", "action-id-conflict"),
  inherited("C07 消息正文冲突放行", "M04", "同消息号的正文冲突被拒绝", "message-id-conflict"),
  inherited("C08 登记不标已处理", "M09", "登记后消息标记已处理", "false !== true"),
  ["C09 来源序号错误", 'sourceSeq: m.seq, status:', 'sourceSeq: m.seq + 1, status:', "登记承诺保留来源序号", "2 !== 1"],
  ["C10 来源文字错误", 'text: m.text.slice(m.text.indexOf(c.text), m.text.indexOf(c.text) + c.text.length), sourceSeq:', 'text: `${c.text}-wrong`, sourceSeq:', "登记承诺保留来源文字", "wrong"],
  inherited("C11 允许伪造文字", "M19", "登记拒绝来源未出现的文字", "commitment-text-not-source"),
  inherited("C12 解析器否认仍完成", "M10", "解析器否认存在时不能完成", "artifact-not-found"),
  ["C13 未指定产物仍完成", 'exists = !!input.artifact && typeof artifactExists', 'exists = typeof artifactExists', "未指定产物时不能完成", "artifact-not-found"],
  ["C14 完成不改变状态", 'status: input.outcome, resolution:', 'status: input.outcome === "done" ? "active" : input.outcome, resolution:', "存在产物的承诺进入完成状态", "active"],
  ["C15 完成丢失产物指针", 'resolution: { artifact: input.artifact, detail: input.detail }', 'resolution: { artifact: null, detail: input.detail }', "完成时保留产物指针", "null"],
  ["C16 撤销状态错记", 'status: input.outcome, resolution:', 'status: input.outcome === "revoked" ? "blocked" : input.outcome, resolution:', "用户撤销保留状态和原因", "blocked"],
  ["C17 替代状态错记", 'status: input.outcome, resolution:', 'status: input.outcome === "superseded" ? "blocked" : input.outcome, resolution:', "替代保留状态和原因", "blocked"],
  ["C18 阻塞状态错记", 'status: input.outcome, resolution:', 'status: input.outcome === "blocked" ? "superseded" : input.outcome, resolution:', "阻塞保留状态和原因", "superseded"],
  ["C19 从未绑定的 Compute 可记进展", '(input.actor.kind === "compute" && input.actor.id !== current.computeId)', '(input.actor.kind === "compute" && input.actor.id !== current.computeId && !(current.computeId === null && !state.actions.some((a) => JSON.parse(a.payload).type === "bind-compute")))', "未绑定 Compute 不得记进展", "actor-not-allowed"],
  inherited("C20 绑定冒充进展", "M22", "绑定动作不冒充本轮进展", "pending"),
  ["C21 拒绝首次绑定的 Compute", '(input.actor.kind === "compute" && input.actor.id !== current.computeId)', '(input.actor.kind === "compute" && (input.actor.id !== current.computeId || state.actions.filter((a) => JSON.parse(a.payload).type === "bind-compute").length === 1))', "当前绑定 Compute 可记进展", "false !== true"],
  ["C22 替换后旧绑定仍获授权", '(input.actor.kind === "compute" && input.actor.id !== current.computeId)', '(input.actor.kind === "compute" && input.actor.id !== current.computeId && !(current.computeId !== null && state.actions.some((a) => { const old = JSON.parse(a.payload); return old.type === "bind-compute" && old.computeId === input.actor.id; })))', "替换后原 Compute 不得记进展", "actor-not-allowed"],
  ["C23 替换后新绑定不能进展", '(input.actor.kind === "compute" && input.actor.id !== current.computeId)', '(input.actor.kind === "compute" && (input.actor.id !== current.computeId || state.actions.some((a) => { const old = JSON.parse(a.payload); return old.type === "bind-compute" && old.computeId !== null && old.computeId !== input.actor.id; })))', "替换后新 Compute 可记进展", "false !== true"],
  inherited("C24 撤销不清除绑定", "M23", "撤销绑定后 Compute 不得记进展", "actor-not-allowed"),
  ["C25 用户可绑定", 'if (input.actor.kind !== "contact" || input.actor.id !== state.ownerId) return fail("actor-not-allowed");', 'if ((input.actor.kind !== "contact" || input.actor.id !== state.ownerId) && input.actor.kind !== "user") return fail("actor-not-allowed");', "用户不能绑定 Compute", "actor-not-allowed"],
  ["C26 Compute 可绑定", 'if (input.actor.kind !== "contact" || input.actor.id !== state.ownerId) return fail("actor-not-allowed");', 'if ((input.actor.kind !== "contact" || input.actor.id !== state.ownerId) && input.actor.kind !== "compute") return fail("actor-not-allowed");', "Compute 不能绑定 Compute", "actor-not-allowed"],
  ["C27 别的联系人可绑定", 'if (input.actor.kind !== "contact" || input.actor.id !== state.ownerId) return fail("actor-not-allowed");', 'if (input.actor.kind !== "contact") return fail("actor-not-allowed");', "非主人联系人不能绑定 Compute", "actor-not-allowed"],
  ["C28 绑定不检查版本", 'if (state.version !== expectedVersion) return fail("version-conflict");', 'if (input.type !== "bind-compute" && state.version !== expectedVersion) return fail("version-conflict");', "绑定检查版本", "version-conflict"],
  inherited("C29 绑定丢失幂等", "M02", "绑定动作重复提交保持幂等", "false !== true"),
  inherited("C30 绑定动作号可变更载荷", "M03", "绑定动作号不能用于另一载荷", "action-id-conflict"),
  ["C31 Compute 跨任务进展", 'if (current.taskId !== input.taskId) return fail("task-mismatch");', 'if (input.type !== "progress" && current.taskId !== input.taskId) return fail("task-mismatch");', "Compute 不得报告其他任务的进展", "task-mismatch"],
  inherited("C32 Compute 可了结承诺", "M14", "Compute 不得了结已绑定承诺", "actor-not-allowed"),
  inherited("C33 闲聊等待全部承诺", "M17", "闲聊不等待未绑定到本轮的承诺", "pending"),
  ["C34 没有活动的承诺不挂起", 'return c.status === "active" && !state.activity', 'return c.status === "active" && state.activity.length > 0 && !state.activity', "本轮未处理的绑定承诺保持待处理", "pending"],
  ["C35 本轮进展不算进展", 'a.roundId === roundId && a.commitmentId === id', 'a.roundId !== roundId && a.commitmentId === id', "本轮已有进展则对账通过", "pending"],
  inherited("C36 别轮进展冒充本轮", "M16", "别轮进展不能冒充本轮进展", "pending"),
  ["C37 用户可完成", '(input.actor.kind === "user" && input.outcome !== "revoked")', '(input.actor.kind === "user" && input.outcome !== "revoked" && input.outcome !== "done")', "用户不得直接完成承诺", "actor-not-allowed"],
  ["C38 用户可替代", '(input.actor.kind === "user" && input.outcome !== "revoked")', '(input.actor.kind === "user" && input.outcome !== "revoked" && input.outcome !== "superseded")', "用户不得直接替代承诺", "actor-not-allowed"],
  ["C39 用户可阻塞", '(input.actor.kind === "user" && input.outcome !== "revoked")', '(input.actor.kind === "user" && input.outcome !== "revoked" && input.outcome !== "blocked")', "用户不得直接阻塞承诺", "actor-not-allowed"],
  ["C40 撤销可缺原因", '!input.detail || input.artifact !== null', '(!input.detail && input.outcome !== "revoked") || input.artifact !== null', "撤销必须有原因", "resolution-required"],
  ["C41 替代可缺原因", '!input.detail || input.artifact !== null', '(!input.detail && input.outcome !== "superseded") || input.artifact !== null', "替代必须有原因", "resolution-required"],
  ["C42 阻塞可缺原因", '!input.detail || input.artifact !== null', '(!input.detail && input.outcome !== "blocked") || input.artifact !== null', "阻塞必须有原因", "resolution-required"],
  ["C43 撤销可带产物", '!input.detail || input.artifact !== null', '!input.detail || (input.artifact !== null && input.outcome !== "revoked")', "撤销不能携带产物", "resolution-required"],
  ["C44 替代可带产物", '!input.detail || input.artifact !== null', '!input.detail || (input.artifact !== null && input.outcome !== "superseded")', "替代不能携带产物", "resolution-required"],
  ["C45 阻塞可带产物", '!input.detail || input.artifact !== null', '!input.detail || (input.artifact !== null && input.outcome !== "blocked")', "阻塞不能携带产物", "resolution-required"],
  inherited("C46 绑定波及其他承诺", "M24", "绑定不会影响其他承诺", "actor-not-allowed"),
  ["C47 不存在的承诺错误原因", 'if (!current) return fail("commitment-not-found");', 'if (!current) return fail("invalid-input");', "绑定拒绝不存在的承诺", "commitment-not-found"],
  ["C48 跨任务绑定", 'if (current.taskId !== input.taskId) return fail("task-mismatch");', 'if (input.type !== "bind-compute" && current.taskId !== input.taskId) return fail("task-mismatch");', "绑定拒绝错误任务", "task-mismatch"],
  inherited("C49 空 Compute 身份放行", "M25", "绑定拒绝空 Compute 身份", "invalid-input"),
  ["C50 可绑定已完成承诺", 'if (current.status !== "active") return fail("commitment-closed");', 'if (input.type !== "bind-compute" && current.status !== "active") return fail("commitment-closed");', "绑定拒绝已完成承诺", "commitment-closed"],
  ["C51 调用顶层 getter", 'const descriptor = descriptors[key];', 'const descriptor = descriptors[key]; if (ancestors.size === 1 && descriptor?.get) Reflect.get(value, key);', "顶层 getter 被拒绝且不调用", "+   1"],
  ["C52 调用顶层 setter", 'const descriptor = descriptors[key];', 'const descriptor = descriptors[key]; if (ancestors.size === 1 && descriptor?.set) Reflect.set(value, key, "x");', "顶层 setter 被拒绝且不调用", "+   1"],
  ["C53 探测顶层命令 Proxy", 'input = jsonCopy(command);', 'input = jsonCopy(types.isProxy(command) ? Object.fromEntries(Object.entries(command)) : command);', "顶层 Proxy 被拒绝且不调用", "invalid-input"],
  ["C54 调用嵌套消息 getter", 'const descriptor = descriptors[key];', 'const descriptor = descriptors[key]; if (ancestors.size > 1 && !Array.isArray(value) && descriptor?.get) Reflect.get(value, key);', "嵌套消息 getter 被拒绝且不调用", "+   1"],
  ["C55 探测嵌套消息 Proxy", 'input = jsonCopy(command);', 'const field = command && typeof command === "object" && !types.isProxy(command) ? Object.getOwnPropertyDescriptor(command, "message")?.value : undefined; input = jsonCopy(types.isProxy(field) ? { ...command, message: Object.fromEntries(Object.entries(field)) } : command);', "嵌套消息 Proxy 被拒绝且不调用", "invalid-input"],
  ["C56 调用数组 getter", 'const descriptor = descriptors[key];', 'const descriptor = descriptors[key]; if (Array.isArray(value) && descriptor?.get) Reflect.get(value, key);', "数组访问器被拒绝且不调用", "+   1"],
  ["C57 更新入口探测账本 Proxy", 'state = jsonCopy(ledger); input = jsonCopy(command);', 'state = jsonCopy(types.isProxy(ledger) ? Object.fromEntries(Object.entries(ledger)) : ledger); input = jsonCopy(command);', "更新入口拒绝账本 Proxy 且不调用", "invalid-input"],
  ["C58 对账入口探测账本 Proxy", 'state = jsonCopy(ledger); ids = jsonCopy(boundIds);', 'state = jsonCopy(types.isProxy(ledger) ? Object.fromEntries(Object.entries(ledger)) : ledger); ids = jsonCopy(boundIds);', "对账入口拒绝账本 Proxy 且不调用", "invalid-input"],
  ["C59 对账入口探测数组 Proxy", 'state = jsonCopy(ledger); ids = jsonCopy(boundIds);', 'state = jsonCopy(ledger); ids = jsonCopy(types.isProxy(boundIds) ? Object.assign([], boundIds) : boundIds);', "对账入口拒绝编号数组 Proxy 且不调用", "invalid-input"],
  ["C60 调用产物解析器 Proxy", '!types.isProxy(artifactExists) && artifactExists(input.artifact) === true', 'artifactExists(input.artifact) === true', "产物解析器 Proxy 不执行", "artifact-not-found"],
  inherited("C61 拒绝合法空任务", "M33", "空任务字段是合法输入", "false !== true"),
  ["C62 账本外壳不冻结", 'Object.freeze(value);', 'if (!("ownerId" in value)) Object.freeze(value);', "返回账本外壳冻结", "false !== true"],
  ["C63 消息数组不冻结", 'Object.freeze(value);', 'if (!Array.isArray(value)) Object.freeze(value);', "返回消息数组冻结", "false !== true"],
  ["C64 消息不冻结", 'Object.freeze(value);', 'if (!("handled" in value)) Object.freeze(value);', "返回消息冻结", "false !== true"],
  ["C65 发送者不冻结", 'Object.freeze(value);', 'if (!("kind" in value)) Object.freeze(value);', "返回消息发送者冻结", "false !== true"],
  ["C66 动作记录不冻结", 'Object.freeze(value);', 'if (!("payload" in value)) Object.freeze(value);', "返回动作记录冻结", "false !== true"],
  ["C67 冻结调用方命令", 'export function applyLedger(ledger: Ledger, expectedVersion: number, command: Command, artifactExists?: (id: string) => boolean): Result {', 'export function applyLedger(ledger: Ledger, expectedVersion: number, command: Command, artifactExists?: (id: string) => boolean): Result {\n  Object.freeze(command);', "不冻结调用方命令", "+   true"],
  inherited("C68 重试未标重复", "M02", "相同动作重试标记重复", "false !== true"),
  ["C69 重试篡改账本版本", 'previous.payload === payload ? { ok: true, ledger: freeze(state), duplicate: true }', 'previous.payload === payload ? { ok: true, ledger: freeze({ ...state, version: state.version + 1 }), duplicate: true }', "相同动作重试不改账本", "version"],
  ["C70 漏登记多个承诺", 'commitments.push(...input.commitments.map((c)', 'commitments.push(...input.commitments.slice(0, 1).map((c)', "一条消息可登记多个承诺", "-   'b'"],
  inherited("C71 新消息冲掉旧承诺", "M08", "新消息保留原有承诺", "active"),
  ["C72 空命令给出错误原因", 'if (!isLedger(state) || !isCommand(input) || !version(expectedVersion)) return fail("invalid-input");', 'if (input === null) return fail("invalid-command");\n  if (!isLedger(state) || !isCommand(input) || !version(expectedVersion)) return fail("invalid-input");', "更新入口拒绝空命令", "invalid-input"],
  ["C73 空账本给出错误原因", 'if (!isLedger(state) || !isCommand(input) || !version(expectedVersion)) return fail("invalid-input");', 'if (state === null) return fail("invalid-ledger");\n  if (!isLedger(state) || !isCommand(input) || !version(expectedVersion)) return fail("invalid-input");', "更新入口拒绝空账本", "invalid-input"],
  ["C74 空版本给出错误原因", 'if (!isLedger(state) || !isCommand(input) || !version(expectedVersion)) return fail("invalid-input");', 'if (expectedVersion === null) return fail("invalid-version");\n  if (!isLedger(state) || !isCommand(input) || !version(expectedVersion)) return fail("invalid-input");', "更新入口拒绝空版本", "invalid-input"],
  ["C75 对账空账本错误原因", 'if (!isLedger(state) || !text(roundId) || !Array.isArray(ids) || !ids.every(text) || new Set(ids).size !== ids.length) return { ok: false, reason: "invalid-input" };', 'if (state === null) return { ok: false, reason: "invalid-ledger" };\n  if (!isLedger(state) || !text(roundId) || !Array.isArray(ids) || !ids.every(text) || new Set(ids).size !== ids.length) return { ok: false, reason: "invalid-input" };', "对账入口拒绝空账本", "invalid-input"],
  ["C76 对账空轮次错误原因", 'if (!isLedger(state) || !text(roundId) || !Array.isArray(ids) || !ids.every(text) || new Set(ids).size !== ids.length) return { ok: false, reason: "invalid-input" };', 'if (roundId === null) return { ok: false, reason: "invalid-round" };\n  if (!isLedger(state) || !text(roundId) || !Array.isArray(ids) || !ids.every(text) || new Set(ids).size !== ids.length) return { ok: false, reason: "invalid-input" };', "对账入口拒绝空轮次", "invalid-input"],
  ["C77 对账空绑定列表错误原因", 'if (!isLedger(state) || !text(roundId) || !Array.isArray(ids) || !ids.every(text) || new Set(ids).size !== ids.length) return { ok: false, reason: "invalid-input" };', 'if (ids === null) return { ok: false, reason: "invalid-ids" };\n  if (!isLedger(state) || !text(roundId) || !Array.isArray(ids) || !ids.every(text) || new Set(ids).size !== ids.length) return { ok: false, reason: "invalid-input" };', "对账入口拒绝空绑定列表", "invalid-input"],
  ["C78 空所有者错误原因", 'if (!text(ownerId)) return fail("invalid-input");', 'if (!text(ownerId)) return fail(ownerId === null ? "invalid-owner" : "invalid-input");', "创建账本拒绝空所有者", "invalid-input"],
  ["C79 空字符串所有者错误原因", 'if (!text(ownerId)) return fail("invalid-input");', 'if (!text(ownerId)) return fail(ownerId === "" ? "invalid-owner" : "invalid-input");', "创建账本拒绝空字符串所有者", "invalid-input"],
  ["C80 探测绑定参与者 Proxy", 'input = jsonCopy(command);', 'const field = command && typeof command === "object" && !types.isProxy(command) ? Object.getOwnPropertyDescriptor(command, "actor")?.value : undefined; input = jsonCopy(types.isProxy(field) ? { ...command, actor: Object.fromEntries(Object.entries(field)) } : command);', "绑定参与者 Proxy 被拒绝且不调用", "invalid-input"],
  ["C81 旧版本失败时修改可变输入", 'if (state.version !== expectedVersion) return fail("version-conflict");', 'if (state.version !== expectedVersion) { if (!Object.isFrozen(ledger)) (ledger as { version: number }).version++; return fail("version-conflict"); }', "旧版本被拒绝时不改调用方账本", "version: 2"],
  ["C82 重复承诺失败时修改消息", 'if (new Set(ids).size !== ids.length || ids.some((id) => commitments.some((c) => c.id === id))) return fail("commitment-id-conflict");', 'if (new Set(ids).size !== ids.length || ids.some((id) => commitments.some((c) => c.id === id))) { if (!Object.isFrozen(ledger)) { const entry = (ledger as unknown as { messages: { seq: number; handled: boolean }[] }).messages.find((m) => m.seq === input.seq); if (entry) entry.handled = true; } return fail("commitment-id-conflict"); }', "重复承诺被拒绝时不改消息状态", "handled: true"],
  ["C83 缺产物失败时修改可变输入", 'if (!exists) return fail("artifact-not-found");', 'if (!exists) { if (!Object.isFrozen(ledger)) (ledger as unknown as { commitments: { status: string }[] }).commitments[0]!.status = "done"; return fail("artifact-not-found"); }', "产物不存在时不改调用方承诺", "status: 'done'"],
  ["C84 拒绝进展仍写入可变输入", 'if (input.actor.kind === "user" || (input.actor.kind === "contact" && input.actor.id !== state.ownerId) ||\n            (input.actor.kind === "compute" && input.actor.id !== current.computeId)) return fail("actor-not-allowed");', 'if (input.actor.kind === "user" || (input.actor.kind === "contact" && input.actor.id !== state.ownerId) ||\n            (input.actor.kind === "compute" && input.actor.id !== current.computeId)) { if (input.actor.kind === "compute" && !Object.isFrozen(ledger)) (ledger as unknown as { activity: unknown[] }).activity.push({ roundId: input.roundId, commitmentId: current.id, taskId: current.taskId, actor: input.actor, kind: "progress", text: input.text }); return fail("actor-not-allowed"); }', "未授权进展不改变本轮待处理状态", "pending"],
  ["C85 后一个承诺来源序号错记", 'sourceSeq: m.seq, status:', 'sourceSeq: input.commitments.length > 1 && c === input.commitments.at(-1) ? m.seq + 1 : m.seq, status:', "多个承诺均保留来源序号", "+   2"],
  ["C86 后一个承诺来源文字错记", 'text: m.text.slice(m.text.indexOf(c.text), m.text.indexOf(c.text) + c.text.length), sourceSeq:', 'text: input.commitments.length > 1 && c === input.commitments.at(-1) ? `${c.text}-wrong` : m.text.slice(m.text.indexOf(c.text), m.text.indexOf(c.text) + c.text.length), sourceSeq:', "多个承诺均保留来源文字", "wrong"],
  ["C87 撤销状态错记", 'status: input.outcome, resolution:', 'status: input.outcome === "revoked" ? "blocked" : input.outcome, resolution:', "撤销状态准确", "blocked"],
  ["C88 撤销原因错记", 'resolution: { artifact: input.artifact, detail: input.detail }', 'resolution: { artifact: input.artifact, detail: input.outcome === "revoked" ? "错误原因" : input.detail }', "撤销原因保留", "错误原因"],
  ["C89 替代状态错记", 'status: input.outcome, resolution:', 'status: input.outcome === "superseded" ? "blocked" : input.outcome, resolution:', "替代状态准确", "blocked"],
  ["C90 替代原因错记", 'resolution: { artifact: input.artifact, detail: input.detail }', 'resolution: { artifact: input.artifact, detail: input.outcome === "superseded" ? "错误原因" : input.detail }', "替代原因保留", "错误原因"],
  ["C91 阻塞状态错记", 'status: input.outcome, resolution:', 'status: input.outcome === "blocked" ? "superseded" : input.outcome, resolution:', "阻塞状态准确", "superseded"],
  ["C92 阻塞原因错记", 'resolution: { artifact: input.artifact, detail: input.detail }', 'resolution: { artifact: input.artifact, detail: input.outcome === "blocked" ? "错误原因" : input.detail }', "阻塞原因保留", "错误原因"],
  ["C93 空命令抛错", 'if (!isLedger(state) || !isCommand(input) || !version(expectedVersion)) return fail("invalid-input");', 'if (input === null) throw new TypeError("null command threw");\n  if (!isLedger(state) || !isCommand(input) || !version(expectedVersion)) return fail("invalid-input");', "更新入口拒绝空命令", "null command threw"],
  ["C94 空账本抛错", 'if (!isLedger(state) || !isCommand(input) || !version(expectedVersion)) return fail("invalid-input");', 'if (state === null) throw new TypeError("null ledger threw");\n  if (!isLedger(state) || !isCommand(input) || !version(expectedVersion)) return fail("invalid-input");', "更新入口拒绝空账本", "null ledger threw"],
  ["C95 空版本抛错", 'if (!isLedger(state) || !isCommand(input) || !version(expectedVersion)) return fail("invalid-input");', 'if (expectedVersion === null) throw new TypeError("null version threw");\n  if (!isLedger(state) || !isCommand(input) || !version(expectedVersion)) return fail("invalid-input");', "更新入口拒绝空版本", "null version threw"],
  ["C96 对账空账本抛错", 'if (!isLedger(state) || !text(roundId) || !Array.isArray(ids) || !ids.every(text) || new Set(ids).size !== ids.length) return { ok: false, reason: "invalid-input" };', 'if (state === null) throw new TypeError("null reconciliation ledger threw");\n  if (!isLedger(state) || !text(roundId) || !Array.isArray(ids) || !ids.every(text) || new Set(ids).size !== ids.length) return { ok: false, reason: "invalid-input" };', "对账入口拒绝空账本", "null reconciliation ledger threw"],
  ["C97 对账空轮次抛错", 'if (!isLedger(state) || !text(roundId) || !Array.isArray(ids) || !ids.every(text) || new Set(ids).size !== ids.length) return { ok: false, reason: "invalid-input" };', 'if (roundId === null) throw new TypeError("null round threw");\n  if (!isLedger(state) || !text(roundId) || !Array.isArray(ids) || !ids.every(text) || new Set(ids).size !== ids.length) return { ok: false, reason: "invalid-input" };', "对账入口拒绝空轮次", "null round threw"],
  ["C98 对账空绑定列表抛错", 'if (!isLedger(state) || !text(roundId) || !Array.isArray(ids) || !ids.every(text) || new Set(ids).size !== ids.length) return { ok: false, reason: "invalid-input" };', 'if (ids === null) throw new TypeError("null bindings threw");\n  if (!isLedger(state) || !text(roundId) || !Array.isArray(ids) || !ids.every(text) || new Set(ids).size !== ids.length) return { ok: false, reason: "invalid-input" };', "对账入口拒绝空绑定列表", "null bindings threw"],
  ["C99 空所有者抛错", 'if (!text(ownerId)) return fail("invalid-input");', 'if (ownerId === null) throw new TypeError("null owner threw");\n  if (!text(ownerId)) return fail("invalid-input");', "创建账本拒绝空所有者", "null owner threw"],
  ["C100 空字符串所有者抛错", 'if (!text(ownerId)) return fail("invalid-input");', 'if (ownerId === "") throw new TypeError("empty owner threw");\n  if (!text(ownerId)) return fail("invalid-input");', "创建账本拒绝空字符串所有者", "empty owner threw"],
];

for (const [name, from, to, criterion, marker] of criteria) {
  mutants.push([name, from, to, `独立判据：${criterion}`]);
  diagnostics[name.split(" ")[0]] = marker;
}

function run(dir) {
  const r = spawnSync(process.execPath, ["--test", "--test-reporter=tap", path.join(dir, "src", "commitment-ledger.test.ts")],
    { cwd: dir, encoding: "utf8", timeout: 30000 });
  const out = r.stdout ?? "";
  const failed = [...out.matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1]);
  const passed = [...out.matchAll(/^ok \d+ - (.+)$/gm)].map((m) => m[1]);
  const blocks = new Map([...out.matchAll(/^# Subtest: (.+)\n([\s\S]*?)(?=^# Subtest: |^1\.\.|$(?![\s\S]))/gm)].map((m) => [m[1], m[2]]));
  return { status: r.status, failed, passed, blocks, error: r.error?.message };
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "d23-ledger-mut-"));
let success = true;
try {
  const makeCopy = (name) => {
    const dir = path.join(tmp, name);
    fs.mkdirSync(dir);
    fs.cpSync(source, path.join(dir, "src"), { recursive: true });
    fs.writeFileSync(path.join(dir, "package.json"), '{"type":"module"}\n');
    return dir;
  };
  const baseline = run(makeCopy("baseline"));
  const baselineOk = baseline.status === 0 && baseline.passed.length === 141 && baseline.failed.length === 0;
  console.log(`${baselineOk ? "PASS" : "FAIL"} 原样对照 ${baseline.passed.length} 通过 / ${baseline.failed.length} 失败`);
  if (!baselineOk) success = false;
  const named = new Set(mutants.map(([, , , expected]) => expected));
  const missing = baseline.passed.filter((name) => !named.has(name));
  const unknown = [...named].filter((name) => !baseline.passed.includes(name));
  const mapped = missing.length === 0 && unknown.length === 0;
  console.log(`${mapped ? "PASS" : "FAIL"} 具名映射 ${named.size}/${baseline.passed.length}; 未映射=${JSON.stringify(missing)} 不存在=${JSON.stringify(unknown)}`);
  if (!mapped) success = false;
  for (const [index, [name, from, to, expected]] of mutants.entries()) {
    const dir = makeCopy(`m${index}`);
    const file = path.join(dir, "src", target);
    const original = fs.readFileSync(file, "utf8");
    if (original.split(from).length !== 2) {
      console.log(`FAIL ${name}: 注入点不是唯一一处`);
      success = false;
      continue;
    }
    fs.writeFileSync(file, original.replace(from, to));
    const result = run(dir);
    const id = name.split(" ")[0];
    const block = result.blocks.get(expected) ?? "";
    const marker = diagnostics[id];
    const exceptionFault = id === "F09" || id === "F19" || /^C9[3-9]$|^C100$/.test(id);
    const rightReason = typeof marker === "string" && block.includes(marker) &&
      (exceptionFault ? block.includes("failureType: 'testCodeFailure'") : block.includes("ERR_ASSERTION"));
    const killed = result.status === 1 && !result.error && result.failed.includes(expected) && rightReason && !result.failed.some((n) => n.endsWith(".test.ts"));
    const evidence = block.split("\n").find((line) => line.includes(marker))?.trim();
    const otherCriteria = result.failed.filter((n) => n.startsWith("独立判据：") && n !== expected);
    console.log(`${killed ? "KILLED" : "SURVIVED"} ${name}: ${killed ? `${expected} diagnostic=${JSON.stringify(evidence)} other_criteria_failures=${JSON.stringify(otherCriteria)}` : `exit=${result.status} failures=${JSON.stringify(result.failed)} marker=${JSON.stringify(marker)} matched=${rightReason} ${result.error ?? ""}`}`);
    if (!killed) success = false;
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(success ? `PASS ${mutants.length}/${mutants.length} 变异被指定测试杀死` : "FAIL 变异校准未通过");
process.exitCode = success ? 0 : 1;
