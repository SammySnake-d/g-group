// Each mutant is applied to a fresh copy. A named test must fail; a load error is not a kill.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const source = path.resolve(import.meta.dirname, "../src");
const target = "commitment-ledger.ts";
const mutants = [
  ["M01 未接收直接处理", 'if (!m) return fail("message-not-found");', "", "未收到的消息不能处理或生成承诺"],
  ["M02 重试丢失幂等性", "if (previous) return previous.payload === payload", "if (false && previous) return previous.payload === payload", "同一投递动作重试按稳定 id 去重,旧版本重试也不重复"],
  ["M03 相同动作号允许不同内容", "previous.payload === payload ?", "true ?", "复用动作 id 改载荷会被拒绝"],
  ["M04 同消息号的冲突被吞掉", "canonical(prior as unknown as Json) === canonical(m as unknown as Json) ?", "true ?", "同一消息 id 重投不重复,但内容冲突不得覆盖"],
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
];

function run(dir) {
  const r = spawnSync(process.execPath, ["--test", "--test-reporter=tap", path.join(dir, "src", "commitment-ledger.test.ts")],
    { cwd: dir, encoding: "utf8", timeout: 30000 });
  const out = r.stdout ?? "";
  const failed = [...out.matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1]);
  const passed = [...out.matchAll(/^ok \d+ - (.+)$/gm)].map((m) => m[1]);
  return { status: r.status, failed, passed, error: r.error?.message };
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
  const baselineOk = baseline.status === 0 && baseline.passed.length === 22 && baseline.failed.length === 0;
  console.log(`${baselineOk ? "PASS" : "FAIL"} 原样对照 ${baseline.passed.length} 通过 / ${baseline.failed.length} 失败`);
  if (!baselineOk) success = false;
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
    const killed = result.status !== 0 && result.failed.includes(expected) && !result.failed.some((n) => n.endsWith(".test.ts"));
    console.log(`${killed ? "KILLED" : "SURVIVED"} ${name}: ${killed ? expected : `exit=${result.status} failures=${JSON.stringify(result.failed)} ${result.error ?? ""}`}`);
    if (!killed) success = false;
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(success ? `PASS ${mutants.length}/${mutants.length} 变异被指定测试杀死` : "FAIL 变异校准未通过");
process.exitCode = success ? 0 : 1;
