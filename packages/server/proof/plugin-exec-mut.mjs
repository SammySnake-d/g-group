// 插件隔离执行与 URL 安装的手工变异校准:每个变异把一处防护改坏,跑本片两个测试文件,记下哪些具名测试失败。
// 用法(仓库根目录):node packages/server/proof/plugin-exec-mut.mjs > packages/server/proof/plugin-exec-mut.txt
// 每个变异把原文的所有出现都替换,跑完用 git checkout 还原被改的文件;任何一个变异没被具名测试杀死就退出 1。
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const RT = "packages/server/src/plugin-runtime.ts";
const PL = "packages/server/src/plugins.ts";
const UT = "packages/server/src/untar.ts";
const HO = "packages/server/src/host.ts";
const RN = "packages/server/runtime/plugin-runner.mjs";
const TESTS = ["packages/server/src/plugin-runtime.test.ts", "packages/server/src/plugins.test.ts"];
const M = [
  ["不开权限模型", RT, '["--permission", ', "["],
  ["继承宿主环境变量", RT, "env: { G_GROUP_PLUGIN_ID: t.id }", "env: { ...process.env, G_GROUP_PLUGIN_ID: t.id }"],
  ["给写文件权限", RT, "`--allow-fs-read=${t.dir}${path.sep}`, ", "`--allow-fs-read=${t.dir}${path.sep}`, `--allow-fs-write=${t.cwd}${path.sep}`, "],
  ["不查符号链接", RT, "if (st.isSymbolicLink()) throw", "if (false && st.isSymbolicLink()) throw"],
  ["不查 .mjs 入口", RT, 'if (!t.entry.endsWith(".mjs")) throw', "if (false) throw"],
  ["超时不结束进程", RT, "const timer = setTimeout(() => this.kill(`插件 ${timeoutMs}ms 没有回应,已结束插件进程`), timeoutMs);", "const timer = setTimeout(() => {}, timeoutMs);"],
  ["非 JSON 输出不当违规", RT, '      this.kill("插件往标准输出写了非 JSON 内容,按协议违规结束插件进程");\n      return;', "      return;"],
  ["不限单行输出(两处检查都去掉)", RT, "> maxLineBytes)", "> Number.POSITIVE_INFINITY)"],
  ["外发超时不留余量(进程先于内核超时)", RT, "this.o.sendTimeoutMs + this.o.sendGraceMs", "this.o.sendTimeoutMs - 1000"],
  ["外发宽限不按参数(固定 200ms)", RT, "this.o.sendTimeoutMs + this.o.sendGraceMs", "this.o.sendTimeoutMs + 200"],
  ["不设堆上限", RT, "`--max-old-space-size=${limits.maxHeapMb}`, ", ""],
  ["回应不按 id 对上(取最早的在途调用)", RT, "const p = typeof m.id === \"number\" ? this.pending.get(m.id) : undefined;\n    if (!p) return;\n    this.pending.delete(m.id as number);", "const first = [...this.pending.entries()][0];\n    if (!first) return;\n    const p = first[1];\n    this.pending.delete(first[0]);"],
  ["插件进程吞掉没人接的拒绝与未捕获的异常", RN, "const entry = process.argv[2];", "const entry = process.argv[2];\nprocess.on(\"unhandledRejection\", () => {});\nprocess.on(\"uncaughtException\", () => {});"],
  ["停用不结束进程", PL, "    if (!enabled) this.d.runtime.stop(id);\n", ""],
  ["改配置不结束进程", PL, "    // 新配置下次调用时以新进程生效(init 只在启动时跑一次)\n    this.d.runtime.stop(id);\n", ""],
  ["卸载不结束进程", PL, "    this.d.runtime.forget(id);\n", ""],
  ["停用后照样调用", PL, 'if (!r.enabled) throw new HostError("conflict", `插件 ${id} 已停用`);', ""],
  ["不核对 sha256", PL, "source.sha256 !== undefined && source.sha256 !== sha256", "false"],
  ["下载不限大小", PL, "        if (total > max) {", "        if (false) {"],
  ["sha256 未给也标已核对", PL, "verified: source.sha256 !== undefined", "verified: true"],
  ["临时目录不清", PL, "      rmSync(tmp, { recursive: true, force: true });\n", ""],
  ["放行链接条目", UT, 'if (type === "1" || type === "2") throw', 'if (false) throw'],
  ["放行上级目录", UT, 'if (segs.includes("..")) throw', "if (false) throw"],
  ["放行绝对路径", UT, 'if (name.startsWith("/") || ', "if ("],
  ["解压不限大小", UT, "gunzipSync(gz, { maxOutputLength: limits.maxBytes })", "gunzipSync(gz)"],
  ["收到时间不用宿主时钟", HO, "new PluginRuntime({ now: opts.clockMs ?? Date.now,", "new PluginRuntime({ now: Date.now,"],
];
const failedNames = (out) => [...out.matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1]);
const run = () => {
  const r = spawnSync(process.execPath, ["--test", "--test-reporter=tap", "--test-concurrency=1", "--test-timeout=120000", ...TESTS], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
};
const base = run();
console.log(`# 原样:exit=${base.code} 失败 ${failedNames(base.out).length} 条 ${base.out.match(/^# (tests|pass|fail) \d+$/gm)?.join(" ") ?? ""}`);
if (base.code !== 0) process.exit(1);
let survived = 0;
for (const [name, file, from, to] of M) {
  const src = readFileSync(file, "utf8");
  if (!src.includes(from)) {
    console.log(`✗ ${name}:${file} 里找不到要改的原文`);
    survived++;
    continue;
  }
  writeFileSync(file, src.split(from).join(to));
  try {
    const r = run();
    const killed = failedNames(r.out);
    if (killed.length === 0) survived++;
    console.log(`${killed.length ? "✓ 杀死" : "✗ 存活"} ${name}(${file}) ← ${killed.join(" | ") || "无"}`);
  } finally {
    execFileSync("git", ["checkout", "--", file]);
  }
}
console.log(`# 变异 ${M.length} 个,存活 ${survived} 个`);
process.exit(survived ? 1 : 0);
