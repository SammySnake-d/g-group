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
  const baselineOk = baseline.status === 0 && baseline.passed.length === 49 && baseline.failed.length === 0;
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
    const rightReason = typeof marker === "string" && block.includes(marker) && (id === "F09" || id === "F19" || block.includes("ERR_ASSERTION"));
    const killed = result.status !== 0 && result.failed.includes(expected) && rightReason && !result.failed.some((n) => n.endsWith(".test.ts"));
    console.log(`${killed ? "KILLED" : "SURVIVED"} ${name}: ${killed ? `${expected} [${marker}]` : `exit=${result.status} failures=${JSON.stringify(result.failed)} marker=${JSON.stringify(marker)} matched=${rightReason} ${result.error ?? ""}`}`);
    if (!killed) success = false;
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(success ? `PASS ${mutants.length}/${mutants.length} 变异被指定测试杀死` : "FAIL 变异校准未通过");
process.exitCode = success ? 0 : 1;
