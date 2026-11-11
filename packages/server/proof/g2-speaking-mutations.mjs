// T-177 G2 = D(AC-32 ③)说话侧配置快照的行为变异校准(R-05 阳性埋雷):按方案 §8 G2-01/G2-02 与审查 G2-a 列的故障,
// 逐个注入单一故障,在隔离副本里跑 G2 的四个测试文件;每个变异必须被为它指定的具名测试杀死(一对一,文件级加载失败不算),
// 每处注入点必须恰好出现 1 次;原样副本必须全绿(阴性对照)。并发 1。
// 副本带整份 packages/,node_modules/@g-group/* 链到副本自己的包——跨包注入(domain)测的才是注入后的代码。
// 用法: node packages/server/proof/g2-speaking-mutations.mjs
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const TESTS = [
  "packages/domain/src/speaking-endpoint.test.ts",
  "packages/server/src/speaking-snapshot.test.ts",
  "packages/server/src/speaking-assembly.test.ts",
  "packages/server/src/speaking-config.test.ts",
];
const H = "packages/server/src/host.ts";
const SP = "packages/server/src/speaking.ts";
const MC = "packages/domain/src/model-config.ts";
const ST = "packages/server/src/start.ts";
const CL = "packages/server/src/cli.ts";
const T_SAME = "G2-01 同一轮对话与补写检查收到同一份冻结快照";
const T_FLIGHT = "G2-01 配置在途改变本轮保持旧值 下一轮才用新值";
const T_CACHE = "G2-01 装配按指纹缓存 同模型换输出上限得到新实例";
const T_PARAMS = "G2-01 对话与压缩器拿同一组宿主级参数 压缩器不自设上限";
const T_START = "G2-01 生产入口真实连线 对话与检查发出的请求同模型同上限同端点";
const T_ENTRY = "G2-01 生产与开发入口对同一份宿主配置给出同一个拒绝";
const T_FIELDS = "G2-01 快照取本轮实际模型与宿主级配置 冻结且推理参数默认空";
const T_FP = "G2-01 指纹覆盖每个非敏感字段与宿主启动号 同输入稳定";
const T_REF = "G2-02 认证位置填了密钥值就拒绝 说明不回显原值";
const T_BADEP = "G2-02 端点参数不合格显式拒绝 不悄悄放大或缩小";
const T_MISMATCH = "G2-02 压缩器绑定模型与本轮快照不同就不调用 不换模型";
const T_LIVE = "G2-02 同模校验用本轮冻结的模型 不用联系人中途改过的现值";
const T_BACKUPCHK = "G2-02 失败卡选了备用模型的那一轮 同模校验按快照判并照常检查";
const T_REASON = "G2-02 推理参数不被支持就显式拒绝 不丢弃后假装继承";
const T_SECRET = "G2-02 密钥只在调用边界按引用解析 不进端点和快照";
const T_G203 = "G2-03 用户选择备用模型重跑 同批对话补写和检查使用同一模型";
const SETTLE = "    const settled = await this.settleNote(contact, speaking, fresh, out, rooms.map((r) => r.id), signal);";
/** [名字, 指定的具名测试, [[文件, 原文, 改成]...]] */
const M = [
  ["G2M01 中途重解析:补写检查另解析一份快照(同模型)", T_SAME, [[H, SETTLE, SETTLE.replace("contact, speaking,", "contact, this.speakingFor(speaking.model),")]]],
  ["G2M02 后台按联系人原模型取快照(备用模型不带进补写检查)", T_G203, [[H, SETTLE, SETTLE.replace("contact, speaking,", "contact, this.speakingFor(contact.speakingModel),")]]],
  ["G2M03 压缩器工厂拿联系人原资料(工厂看到的模型不是本轮实际模型)", T_G203, [[H, "    let compactor = this.opts.compactor?.({ ...this.contactView(contact), speakingModel: speaking.model }, speaking);", "    let compactor = this.opts.compactor?.(this.contactView(contact), speaking);"]]],
  ["G2M04 端点只在宿主启动时读一次(在途改动下一轮也不生效)", T_FLIGHT, [[H, "  private speakingFor(model: string): modelConfig.EffectiveSpeakingConfig {\n    return modelConfig.resolveSpeakingConfig((this.opts.speakingEndpoint ?? (() => modelConfig.DEFAULT_SPEAKING_ENDPOINT))(), model, this.bootId);", "  private speakingFor(model: string): modelConfig.EffectiveSpeakingConfig {\n    this.fixedEndpoint ??= (this.opts.speakingEndpoint ?? (() => modelConfig.DEFAULT_SPEAKING_ENDPOINT))();\n    return modelConfig.resolveSpeakingConfig(this.fixedEndpoint, model, this.bootId);"], [H, "  readonly bootId: string;\n", "  readonly bootId: string;\n  private fixedEndpoint: modelConfig.SpeakingEndpoint | undefined;\n"]]],
  ["G2M05 不读宿主级端点,一律用默认值", T_SAME, [[H, "    return modelConfig.resolveSpeakingConfig((this.opts.speakingEndpoint ?? (() => modelConfig.DEFAULT_SPEAKING_ENDPOINT))(), model, this.bootId);", "    return modelConfig.resolveSpeakingConfig(modelConfig.DEFAULT_SPEAKING_ENDPOINT, model, this.bootId);"]]],
  ["G2M06 删除同模校验", T_MISMATCH, [[H, "      if (!check.ok) {\n        this.report(\"compression-model-mismatch\"", "      if (false) {\n        this.report(\"compression-model-mismatch\""]]],
  ["G2M07 同模校验按联系人永久模型判(不用本轮快照)", T_BACKUPCHK, [[H, "      const check = modelConfig.checkCompressionCall({ ...this.contactModels(contact), speakingModel: speaking.model }, compactor.model);", "      const check = modelConfig.checkCompressionCall(this.contactModels(contact), compactor.model);"]]],
  ["G2M08 同模校验现取联系人中途改过的模型", T_LIVE, [[H, "      const check = modelConfig.checkCompressionCall({ ...this.contactModels(contact), speakingModel: speaking.model }, compactor.model);", "      const check = modelConfig.checkCompressionCall(this.contactModels(this.contactDoc(contactId).value), compactor.model);"]]],
  ["G2M09 装配按模型名缓存(不按指纹)", T_CACHE, [[SP, "      let m = minds.get(s.fingerprint);", "      let m = minds.get(s.model);"], [SP, "        minds.set(s.fingerprint, m);", "        minds.set(s.model, m);"]]],
  ["G2M10 压缩器自设较小输出上限", T_PARAMS, [[SP, "        k = mod.createPiCompactor(adapterOptions(o.env, s, o.fetch));", "        k = mod.createPiCompactor({ ...adapterOptions(o.env, s, o.fetch), maxTokens: 4096 });"]]],
  ["G2M11 静默丢弃不支持的推理参数", T_REASON, [[SP, "  if (Object.keys(s.reasoning).length > 0) throw", "  if (false) throw"]]],
  ["G2M12 端点不读环境里的输出上限", T_PARAMS, [[SP, '    maxOutputTokens: positive(env, "GG_SPEAKING_MAX_OUTPUT_TOKENS", d.maxOutputTokens),', "    maxOutputTokens: d.maxOutputTokens,"]]],
  ["G2M13 密钥值写进端点认证引用", T_SECRET, [[SP, '  const authRef = env.ANTHROPIC_AUTH_TOKEN ? "bearer:env:ANTHROPIC_AUTH_TOKEN" : env.ANTHROPIC_API_KEY ? "x-api-key:env:ANTHROPIC_API_KEY" : "none";', '  const authRef = env.ANTHROPIC_AUTH_TOKEN ? "bearer:env:ANTHROPIC_AUTH_TOKEN" : env.ANTHROPIC_API_KEY ? `x-api-key:env:ANTHROPIC_API_KEY:${env.ANTHROPIC_API_KEY}` : "none";'], [MC, "const AUTH_REF = /^(?:none|(?:bearer|x-api-key):env:[A-Z_][A-Z0-9_]*)$/;", "const AUTH_REF = /^(?:none|(?:bearer|x-api-key):env:[A-Z_][A-Z0-9_]*(?::.*)?)$/;"]]],
  ["G2M14 生产入口不把端点交给宿主", T_START, [[ST, "    speakingEndpoint: () => speaking.endpoint,\n", ""]]],
  ["G2M15 开发入口另写一套端点默认值(不读环境里的上限)", T_ENTRY, [[CL, "  const speaking = await assembleSpeaking({ kind: values.mind, env: process.env });", "  const speaking = await assembleSpeaking({ kind: values.mind, env: { ...process.env, GG_SPEAKING_MAX_OUTPUT_TOKENS: undefined } });"]]],
  ["G2M16 认证引用不校验格式(密钥值可进快照)", T_REF, [[MC, '  if (typeof e.authRef !== "string" || !AUTH_REF.test(e.authRef)) bad(', '  if (typeof e.authRef !== "string") bad(']]],
  ["G2M17 拒绝说明回显认证位置的原值", T_REF, [[MC, '  if (typeof e.authRef !== "string" || !AUTH_REF.test(e.authRef)) bad("authRef 必须是认证引用', '  if (typeof e.authRef !== "string" || !AUTH_REF.test(e.authRef)) bad(`${String(e.authRef)} ` + "authRef 必须是认证引用']]],
  ["G2M18 指纹漏掉输出上限", T_FP, [[MC, "JSON.stringify(canonical({ ...body, bootId }))", "JSON.stringify(canonical({ ...body, maxOutputTokens: 0, bootId }))"]]],
  ["G2M19 指纹漏掉宿主启动号", T_FP, [[MC, "JSON.stringify(canonical({ ...body, bootId }))", "JSON.stringify(canonical({ ...body }))"]]],
  ["G2M20 快照不冻结", T_FIELDS, [[MC, "  return freeze({ ...body, fingerprint: speakingFingerprint(body, bootId) });", "  return { ...body, fingerprint: speakingFingerprint(body, bootId) };"]]],
  ["G2M21 输出上限大于窗口也放行", T_BADEP, [[MC, '  if (e.maxOutputTokens > e.contextWindow) bad(', '  if (false) bad(']]],
];
const TIMEOUT_MS = Number(process.env.MUT_TIMEOUT_MS ?? 300_000);
function run(dir) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--test", "--test-concurrency=1", "--test-timeout=120000", "--test-force-exit", "--test-reporter=tap", ...TESTS], { cwd: dir, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let timedOut = false;
    child.stdout.on("data", (d) => {
      out += d;
    });
    child.stderr.on("data", () => {});
    const kill = () => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        /* 已退出 */
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, TIMEOUT_MS);
    child.on("close", (code) => {
      clearTimeout(timer);
      kill();
      const failed = [...out.matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1]);
      const passed = [...out.matchAll(/^ok \d+ - (.+)$/gm)].map((m) => m[1]);
      resolve({ code, failed, passed, timedOut });
    });
  });
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "g2-speaking-mut-"));
const pkgs = fs.readdirSync(path.join(ROOT, "packages"));
/** 副本:整份 packages/(不含 proof)+ node_modules(第三方链到原树,@g-group/* 链到副本自己的包) */
const copy = (name) => {
  const d = path.join(tmp, name);
  fs.cpSync(path.join(ROOT, "packages"), path.join(d, "packages"), { recursive: true, filter: (s) => !s.includes(`${path.sep}proof`) && !s.includes(`${path.sep}node_modules`) });
  for (const f of ["package.json", "tsconfig.json"]) fs.copyFileSync(path.join(ROOT, f), path.join(d, f));
  fs.mkdirSync(path.join(d, "node_modules", "@g-group"), { recursive: true });
  for (const e of fs.readdirSync(path.join(ROOT, "node_modules"))) {
    if (e === "@g-group" || e === ".bin" || e.startsWith(".")) continue;
    fs.symlinkSync(path.join(ROOT, "node_modules", e), path.join(d, "node_modules", e));
  }
  for (const p of pkgs) fs.symlinkSync(path.join("..", "..", "packages", p), path.join(d, "node_modules", "@g-group", p));
  return d;
};
const count = (s, sub) => s.split(sub).length - 1;

let ok = true;
console.log(`node ${process.version},变异 ${M.length} 个,测试文件 ${TESTS.length} 个`);
const clean = await run(copy("clean"));
const good = !clean.timedOut && clean.code === 0 && clean.failed.length === 0 && clean.passed.length > 0;
console.log(`${good ? "✓" : "✗"} 原样副本:${clean.passed.length} 绿 / ${clean.failed.length} 红${clean.failed.length ? `(${clean.failed.join(";")})` : ""}`);
if (!good) ok = false;
const named = new Set(clean.passed);
let killed = 0;
let survived = 0;
for (const [i, [name, expect, edits]] of M.entries()) {
  const tag = `[${i + 1}/${M.length}]`;
  const d = copy(`m${i}`);
  let bad = null;
  for (const [file, from, to] of edits) {
    const f = path.join(d, file);
    const src = fs.readFileSync(f, "utf8");
    const n = count(src, from);
    if (n !== 1) {
      bad = `${file} 注入点出现 ${n} 次`;
      break;
    }
    fs.writeFileSync(f, src.replace(from, to));
  }
  if (bad) {
    ok = false;
    survived++;
    console.log(`✗ ${tag} ${name}:${bad},必须恰好 1 次`);
    fs.rmSync(d, { recursive: true, force: true });
    continue;
  }
  const t0 = Date.now();
  const r = await run(d);
  fs.rmSync(d, { recursive: true, force: true });
  const kills = r.failed.filter((t) => named.has(t));
  if (!named.has(expect)) {
    ok = false;
    survived++;
    console.log(`✗ ${tag} ${name}:指定的具名测试「${expect}」不在原样副本的通过列表里`);
    continue;
  }
  if (!r.timedOut && kills.includes(expect)) {
    killed++;
    console.log(`✓ ${tag} ${name}:${r.passed.length} 绿 / ${r.failed.length} 红,用时 ${((Date.now() - t0) / 1000).toFixed(1)}s,被发现:${kills.map((k) => `「${k}」`).join("")}`);
  } else {
    ok = false;
    survived++;
    console.log(`✗ ${tag} ${name}:${r.timedOut ? "超时" : `${r.passed.length} 绿 / ${r.failed.length} 红,指定的「${expect}」没有失败${kills.length ? `(变红的是 ${kills.join(";")})` : ""}`}`);
  }
}
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`合计 ${M.length}:杀死 ${killed},存活 ${survived}`);
console.log(ok ? "变异校准通过" : "变异校准失败");
process.exit(ok ? 0 : 1);
