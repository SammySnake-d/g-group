import assert from "node:assert/strict";
import { test } from "node:test";
import {
  attachable,
  canInvoke,
  changesSince,
  commandUsage,
  compareSemver,
  hasUpdate,
  isValidSemver,
  marketCounts,
  marketList,
  notInstalled,
  parseManifestText,
  parseSemver,
  permissionDiff,
  permissionsToConsent,
  pluginCommands,
  pluginReducer,
  readInstallSource,
  seedInstalled,
  validateManifest,
  type PluginInstall,
  type PluginManifest,
  type PluginPermission,
  type RiskLevel,
} from "./plugins.ts";

const perm = (scope: string, risk: RiskLevel): PluginPermission => ({ scope, detail: `说明:${scope}`, risk });
const READ = perm("feishu.messages:read", "medium");
const DOCS = perm("feishu.docs:read", "medium");
const SEND = perm("feishu.messages:send", "high");
const cmd = (name: string) => ({ name, title: `标题 ${name}`, desc: `说明 ${name}`, args: [] });
const mf = (over: Partial<PluginManifest>): PluginManifest => ({
  id: "g-group.feishu",
  name: "飞书",
  publisher: "g-group 官方",
  version: "1.4.2",
  category: "source",
  summary: "读飞书群消息,勾选几条带进对话",
  description: "详细说明",
  icon: { letter: "飞", color: "#3370ff" },
  permissions: [READ],
  contributes: { commands: [{ name: "feishu", title: "取飞书消息", desc: "从飞书群取几条消息带进对话", args: [{ name: "群名", desc: "飞书群的名字", required: true }, { name: "条数", desc: "默认 10", required: false }] }], panels: [], events: [] },
  changelog: [{ version: "1.4.2", date: "2026-09-20", notes: ["修了长消息被截断"] }],
  ...over,
});
/** 一份合法的原始清单(JSON 里的样子) */
const raw = (over: Record<string, unknown> = {}) => ({
  id: "acme.notes",
  name: "笔记",
  publisher: "Acme",
  version: "0.1.0",
  category: "command",
  summary: "把消息存成笔记",
  description: "选中几条消息,存成一条笔记",
  permissions: [{ scope: "notes.write", detail: "在你的笔记库里新建笔记", risk: "low" }],
  ...over,
});

// ---------------------------------------------------------------- semver

test("parseSemver / isValidSemver:只认 主.次.修订[-预发布][+构建]", () => {
  assert.deepEqual(parseSemver("1.4.2"), { major: 1, minor: 4, patch: 2, pre: [] });
  assert.deepEqual(parseSemver("10.0.3-rc.1+build.5"), { major: 10, minor: 0, patch: 3, pre: ["rc", "1"] });
  for (const bad of ["1.2", "01.2.3", "1.2.3.4", "v1.2.3", "", "1.2.3-", "1.2.-3", "1.2.3-01"]) assert.equal(parseSemver(bad), undefined, bad);
  assert.equal(isValidSemver("0.0.1"), true);
  assert.equal(isValidSemver("1.2"), false);
  assert.equal(isValidSemver(123), false);
});

test("compareSemver:逐段按数字比,预发布低于正式版,预发布标识按规范比较", () => {
  assert.equal(compareSemver("1.10.0", "1.9.9"), 1);
  assert.equal(compareSemver("1.4.2", "1.5.0"), -1);
  assert.equal(compareSemver("2.0.0", "2.0.0"), 0);
  assert.equal(compareSemver("2.0.0", "10.0.0"), -1);
  assert.equal(compareSemver("1.0.0", "1.0.0-rc.1"), 1);
  assert.equal(compareSemver("1.0.0-alpha", "1.0.0-alpha.1"), -1);
  assert.equal(compareSemver("1.0.0-alpha.1", "1.0.0-alpha.beta"), -1);
  assert.equal(compareSemver("1.0.0-beta.2", "1.0.0-beta.11"), -1);
  assert.equal(compareSemver("1.0.0-rc.1", "1.0.0-beta.11"), 1);
  assert.equal(compareSemver("1.2.3+build.1", "1.2.3+build.9"), 0);
  assert.throws(() => compareSemver("1.2", "1.0.0"), /版本号「1\.2」不合法/);
});

// ---------------------------------------------------------------- 清单校验

test("validateManifest:合法清单通过,并补齐默认图标、空的能力和更新日志", () => {
  const r = validateManifest(raw());
  assert.deepEqual(r, {
    ok: true,
    manifest: {
      id: "acme.notes",
      name: "笔记",
      publisher: "Acme",
      version: "0.1.0",
      category: "command",
      summary: "把消息存成笔记",
      description: "选中几条消息,存成一条笔记",
      icon: { letter: "笔", color: "#71717a" },
      permissions: [{ scope: "notes.write", detail: "在你的笔记库里新建笔记", risk: "low" }],
      contributes: { commands: [], panels: [], events: [] },
      changelog: [],
    },
  });
  const full = validateManifest(raw({
    icon: { letter: "记", color: "#0f766e" },
    contributes: { commands: [{ name: "note", title: "存笔记", desc: "把选中的消息存成笔记", args: [{ name: "标题", desc: "笔记标题", required: true }] }], panels: [{ id: "notes", title: "笔记", desc: "看本群存过的笔记" }], events: [{ name: "message.created", desc: "有新消息" }] },
    changelog: [{ version: "0.1.0", date: "2026-10-30", notes: ["第一版"] }],
  }));
  assert.equal(full.ok, true);
  assert.deepEqual(full.ok && full.manifest.icon, { letter: "记", color: "#0f766e" });
  assert.deepEqual(full.ok && full.manifest.contributes.commands, [{ name: "note", title: "存笔记", desc: "把选中的消息存成笔记", args: [{ name: "标题", desc: "笔记标题", required: true }] }]);
  assert.deepEqual(full.ok && full.manifest.contributes.panels, [{ id: "notes", title: "笔记", desc: "看本群存过的笔记" }]);
  assert.deepEqual(full.ok && full.manifest.changelog, [{ version: "0.1.0", date: "2026-10-30", notes: ["第一版"] }]);
});

test("validateManifest:缺字段逐个列出中文说明", () => {
  assert.deepEqual(validateManifest({ name: "x" }), {
    ok: false,
    errors: [
      "缺少字段 id(插件 id)",
      "缺少字段 publisher(发布者)",
      "缺少字段 version(版本号)",
      "缺少字段 category(类别)",
      "缺少字段 summary(一句话简介)",
      "缺少字段 description(详细说明)",
      "缺少字段 permissions(权限列表)",
    ],
  });
  assert.deepEqual(validateManifest([1, 2]), { ok: false, errors: ["清单必须是一个 JSON 对象"] });
  assert.deepEqual(validateManifest(raw({ name: "  ", permissions: [{ scope: "a.b" }] })), {
    ok: false,
    errors: ["名称(name)不能为空", "权限第 1 项缺少字段 detail(具体说明)", "权限第 1 项缺少字段 risk(风险级别)"],
  });
});

test("validateManifest:版本号、类别、id、简介长度不合法", () => {
  assert.deepEqual(validateManifest(raw({ version: "1.2" })), { ok: false, errors: ["版本号「1.2」不合法:要写成 主版本.次版本.修订号,比如 1.4.2"] });
  assert.deepEqual(validateManifest(raw({ category: "widget" })), { ok: false, errors: ["类别「widget」不合法:只能是 source(取数据) / outbound(发出去) / ui(面板) / command(命令)"] });
  assert.deepEqual(validateManifest(raw({ id: "Acme Notes" })), { ok: false, errors: ["插件 id「Acme Notes」不合法:只能用小写字母、数字、点和 -,3–64 位,比如 g-group.feishu"] });
  assert.deepEqual(validateManifest(raw({ summary: "很".repeat(81) })), { ok: false, errors: ["一句话简介太长:最多 80 字,现在 81 字"] });
  assert.deepEqual(validateManifest(raw({ changelog: [{ version: "0.1", date: "10/30", notes: [] }] })), {
    ok: false,
    errors: ["更新日志第 1 条的版本号「0.1」不合法:要写成 主版本.次版本.修订号", "更新日志第 1 条的日期「10/30」不合法:要写成 YYYY-MM-DD"],
  });
});

test("validateManifest:权限风险级别只能是 low / medium / high,范围不能重复", () => {
  const r = validateManifest(raw({
    permissions: [
      { scope: "mail.send", detail: "以你的名义发邮件", risk: "critical" },
      { scope: "mail.read", detail: "读收件箱", risk: "高" },
      { scope: "mail.read", detail: "再读一次", risk: "low" },
    ],
  }));
  assert.deepEqual(r, {
    ok: false,
    errors: [
      "权限第 1 项「mail.send」的风险级别「critical」不合法:只能是 low(低) / medium(中) / high(高)",
      "权限第 2 项「mail.read」的风险级别「高」不合法:只能是 low(低) / medium(中) / high(高)",
      "权限「mail.read」重复了",
    ],
  });
});

test("validateManifest:命令名只许小写字母数字和 -,2–32 位,不能重复", () => {
  const r = validateManifest(raw({
    contributes: { commands: [cmd("Mail"), cmd("m"), cmd("a".repeat(33)), cmd("send_mail"), cmd("mail-2"), cmd("mail-2"), cmd("ok-32".padEnd(32, "x"))] },
  }));
  assert.deepEqual(r, {
    ok: false,
    errors: [
      "命令名「/Mail」不合法:只能用小写字母、数字和 -,2–32 位",
      "命令名「/m」不合法:只能用小写字母、数字和 -,2–32 位",
      `命令名「/${"a".repeat(33)}」不合法:只能用小写字母、数字和 -,2–32 位`,
      "命令名「/send_mail」不合法:只能用小写字母、数字和 -,2–32 位",
      "命令 /mail-2 重复了",
    ],
  });
});

test("parseManifestText:JSON 语法错给中文位置,不是对象也拒", () => {
  assert.deepEqual(parseManifestText('{"id": "a",}'), { ok: false, errors: ["不是合法的 JSON:第 1 行第 12 列附近有错"] });
  assert.deepEqual(parseManifestText('{\n  "id": "a",\n}'), { ok: false, errors: ["不是合法的 JSON:第 3 行第 1 列附近有错"] });
  assert.deepEqual(parseManifestText('{"a":}'), { ok: false, errors: ["不是合法的 JSON:有不该出现的「}」"] });
  assert.deepEqual(parseManifestText(""), { ok: false, errors: ["不是合法的 JSON:内容不完整,可能少了括号或引号"] });
  assert.deepEqual(parseManifestText("[]"), { ok: false, errors: ["清单必须是一个 JSON 对象"] });
  const good = parseManifestText(JSON.stringify(raw()));
  assert.equal(good.ok && good.manifest.id, "acme.notes");
});

test("readInstallSource:{ 开头当清单,https 当地址,其它说清楚为什么不行", () => {
  assert.deepEqual(readInstallSource("   "), { kind: "empty" });
  const m = readInstallSource(` ${JSON.stringify(raw({ version: "x" }))} `);
  assert.deepEqual(m, { kind: "manifest", check: { ok: false, errors: ["版本号「x」不合法:要写成 主版本.次版本.修订号,比如 1.4.2"] } });
  assert.deepEqual(readInstallSource("https://plugins.example.com/feishu/manifest.json"), { kind: "url", url: "https://plugins.example.com/feishu/manifest.json" });
  assert.deepEqual(readInstallSource("http://localhost:8080/m.json"), { kind: "url", url: "http://localhost:8080/m.json" });
  assert.deepEqual(readInstallSource("http://plugins.example.com/m.json"), { kind: "invalid", error: "只接受 https 地址,现在是「http」" });
  assert.deepEqual(readInstallSource("飞书插件"), { kind: "invalid", error: "看不出是清单还是地址:粘贴清单 JSON(以 { 开头),或者 https:// 开头的地址" });
});

// ---------------------------------------------------------------- 权限比较

test("permissionDiff / permissionsToConsent:新增和风险升高要重新同意,降低和删掉的不用", () => {
  const granted = [READ, perm("feishu.users:read", "high"), perm("feishu.chats:list", "low")];
  const next = [perm("feishu.messages:read", "high"), perm("feishu.users:read", "low"), DOCS];
  assert.deepEqual(permissionDiff(granted, next), {
    added: [DOCS],
    raised: [perm("feishu.messages:read", "high")],
    removed: [perm("feishu.chats:list", "low")],
  });
  assert.deepEqual(permissionsToConsent(granted, next), [DOCS, perm("feishu.messages:read", "high")]);
  assert.deepEqual(permissionsToConsent(granted, granted), []);
});

// ---------------------------------------------------------------- 生命周期

test("pluginReducer:未安装 → 安装中 → 已启用 ⇄ 已停用 → 卸载中 → 未安装", () => {
  const m = mf({});
  const phases: string[] = [];
  let s: PluginInstall = notInstalled(m.id);
  for (const a of [
    { type: "install", manifest: m, consent: [READ.scope] },
    { type: "install_done" },
    { type: "disable" },
    { type: "enable" },
    { type: "uninstall" },
    { type: "uninstall_done" },
  ] as const) {
    const r = pluginReducer(s, a);
    assert.equal(r.ok, true, a.type);
    if (a.type === "install") {
      assert.deepEqual(r.state.pending, m);
      assert.equal(r.state.manifest, null);
      assert.deepEqual(r.state.granted, [READ]);
    }
    if (a.type === "install_done") {
      assert.deepEqual(r.state.manifest, m);
      assert.equal(r.state.pending, null);
    }
    s = r.state;
    phases.push(s.phase);
  }
  assert.deepEqual(phases, ["installing", "enabled", "disabled", "enabled", "uninstalling", "not_installed"]);
  assert.deepEqual(s, notInstalled(m.id));
  const failed = pluginReducer(pluginReducer(notInstalled(m.id), { type: "install", manifest: m, consent: [READ.scope] }).state, { type: "install_failed" });
  assert.deepEqual(failed, { ok: true, state: notInstalled(m.id) });
});

test("pluginReducer:非法转移返回错误,状态原样不动", () => {
  const m = mf({});
  const none = notInstalled(m.id);
  const on = seedInstalled(m, { enabled: true, convs: ["g"], callers: ["argon"] });
  const off = seedInstalled(m, { enabled: false, convs: [], callers: [] });
  const installing = pluginReducer(none, { type: "install", manifest: m, consent: [READ.scope] }).state;
  const removing = pluginReducer(on, { type: "uninstall" }).state;
  const cases: [PluginInstall, Parameters<typeof pluginReducer>[1], string][] = [
    [none, { type: "enable" }, "「g-group.feishu」现在是「未安装」,不能启用"],
    [none, { type: "attach", conv: "g" }, "「g-group.feishu」现在是「未安装」,不能挂到聊天"],
    [none, { type: "uninstall" }, "「g-group.feishu」现在是「未安装」,不能卸载"],
    [off, { type: "disable" }, "「飞书」现在是「已停用」,不能停用"],
    [on, { type: "enable" }, "「飞书」现在是「已启用」,不能启用"],
    [on, { type: "install", manifest: m, consent: [READ.scope] }, "「飞书」现在是「已启用」,不能安装"],
    [on, { type: "install_done" }, "「飞书」现在是「已启用」,不能完成安装"],
    [installing, { type: "uninstall" }, "「飞书」现在是「安装中」,不能卸载"],
    [installing, { type: "allow", caller: "argon" }, "「飞书」现在是「安装中」,不能加调用者"],
    [removing, { type: "update", manifest: mf({ version: "2.0.0" }), consent: [] }, "「飞书」现在是「卸载中」,不能更新"],
    [removing, { type: "detach", conv: "g" }, "「飞书」现在是「卸载中」,不能从聊天摘下"],
  ];
  for (const [s, a, error] of cases) {
    const r = pluginReducer(s, a);
    assert.equal(r.ok, false, error);
    assert.equal(!r.ok && r.error, error);
    assert.equal(r.state, s, `${error}:必须返回原来的对象`);
  }
});

test("pluginReducer:安装必须同意清单里的全部权限,差几项就列出几项", () => {
  const m = mf({ permissions: [READ, DOCS, SEND] });
  const s = notInstalled(m.id);
  const r = pluginReducer(s, { type: "install", manifest: m, consent: [READ.scope] });
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.error, "还有 2 项权限没同意:「说明:feishu.docs:read」「说明:feishu.messages:send」");
  assert.deepEqual(!r.ok && r.needsConsent, [DOCS, SEND]);
  assert.equal(r.state, s);
  const none = pluginReducer(s, { type: "install", manifest: m, consent: [] });
  assert.deepEqual(!none.ok && none.needsConsent, [READ, DOCS, SEND]);
  const all = pluginReducer(s, { type: "install", manifest: m, consent: [SEND.scope, READ.scope, DOCS.scope, "多余的"] });
  assert.equal(all.ok, true);
  assert.equal(all.state.phase, "installing");
  assert.deepEqual(all.state.granted, [READ, DOCS, SEND]);
  const wrong = pluginReducer(notInstalled("acme.other"), { type: "install", manifest: m, consent: [READ.scope, DOCS.scope, SEND.scope] });
  assert.equal(!wrong.ok && wrong.error, "清单 id「g-group.feishu」和要装的插件「acme.other」不一致");
  const empty = pluginReducer(notInstalled("acme.x"), { type: "install", manifest: mf({ id: "acme.x", permissions: [] }), consent: [] });
  assert.equal(empty.ok, true);
});

test("pluginReducer:更新要比已装新;新增或升高的权限要重新同意,返回差集", () => {
  const s = seedInstalled(mf({}), { enabled: false, convs: ["g"], callers: ["argon"] });
  const same = pluginReducer(s, { type: "update", manifest: mf({}), consent: [] });
  assert.equal(!same.ok && same.error, "已经是 v1.4.2,不用更新");
  const older = pluginReducer(s, { type: "update", manifest: mf({ version: "1.3.0" }), consent: [] });
  assert.equal(!older.ok && older.error, "v1.3.0 比已装的 v1.4.2 旧,不能降级");

  const next = mf({ version: "1.5.0", permissions: [READ, DOCS] });
  const ask = pluginReducer(s, { type: "update", manifest: next, consent: [] });
  assert.equal(ask.ok, false);
  assert.equal(!ask.ok && ask.error, "v1.5.0 多要了 1 项权限,要你重新同意");
  assert.deepEqual(!ask.ok && ask.needsConsent, [DOCS]);
  assert.equal(ask.state, s);

  const done = pluginReducer(s, { type: "update", manifest: next, consent: [DOCS.scope] });
  assert.equal(done.ok, true);
  assert.equal(done.state.manifest?.version, "1.5.0");
  assert.deepEqual(done.state.granted, [READ, DOCS]);
  assert.deepEqual([done.state.phase, done.state.convs, done.state.callers], ["disabled", ["g"], ["argon"]]);

  const raised = pluginReducer(s, { type: "update", manifest: mf({ version: "2.0.0", permissions: [perm(READ.scope, "high")] }), consent: [] });
  assert.deepEqual(!raised.ok && raised.needsConsent, [perm(READ.scope, "high")]);
  const fewer = pluginReducer(seedInstalled(next, { enabled: true, convs: [], callers: [] }), { type: "update", manifest: mf({ version: "1.6.0", permissions: [DOCS] }), consent: [] });
  assert.equal(fewer.ok, true);
  assert.deepEqual(fewer.state.granted, [DOCS]);
});

test("pluginReducer:挂到聊天 / 摘下、谁能调用;canInvoke 四道关全过才为真", () => {
  let s = seedInstalled(mf({}), { enabled: true, convs: [], callers: [] });
  assert.equal(canInvoke(s, "argon", "g"), false);
  const steps: [Parameters<typeof pluginReducer>[1], string | null][] = [
    [{ type: "attach", conv: "g" }, null],
    [{ type: "attach", conv: "g" }, "「飞书」已经挂在这个聊天上了"],
    [{ type: "attach", conv: "" }, "没有指定聊天"],
    [{ type: "allow", caller: "argon" }, null],
    [{ type: "allow", caller: "argon" }, "它已经能调用了"],
  ];
  for (const [a, err] of steps) {
    const r = pluginReducer(s, a);
    assert.equal(r.ok ? null : r.error, err);
    s = r.state;
  }
  assert.deepEqual([s.convs, s.callers], [["g"], ["argon"]]);
  assert.equal(canInvoke(s, "argon", "g"), true);
  assert.equal(canInvoke(s, "codex", "g"), false);
  assert.equal(canInvoke(s, "argon", "g-design"), false);
  assert.equal(canInvoke(pluginReducer(s, { type: "disable" }).state, "argon", "g"), false);
  const notThere = pluginReducer(s, { type: "detach", conv: "g-design" });
  assert.equal(!notThere.ok && notThere.error, "「飞书」没有挂在这个聊天上");
  s = pluginReducer(s, { type: "detach", conv: "g" }).state;
  s = pluginReducer(s, { type: "disallow", caller: "argon" }).state;
  assert.deepEqual([s.convs, s.callers], [[], []]);
  const again = pluginReducer(s, { type: "disallow", caller: "argon" });
  assert.equal(!again.ok && again.error, "它本来就不能调用");
});

test("hasUpdate / changesSince:按 semver 判断有无更新,列出已装版本之后的日志", () => {
  const latest = mf({
    version: "1.5.0",
    changelog: [
      { version: "1.5.0", date: "2026-11-02", notes: ["能读飞书文档"] },
      { version: "1.4.10", date: "2026-10-12", notes: ["修了重复消息"] },
      { version: "1.4.2", date: "2026-09-20", notes: ["修了长消息被截断"] },
    ],
  });
  const s = seedInstalled(mf({}), { enabled: true, convs: [], callers: [] });
  assert.equal(hasUpdate(s, latest), true);
  assert.equal(hasUpdate(s, mf({})), false);
  assert.equal(hasUpdate(seedInstalled(latest, { enabled: false, convs: [], callers: [] }), mf({})), false);
  assert.equal(hasUpdate(notInstalled(latest.id), latest), false);
  assert.equal(hasUpdate(null, latest), false);
  assert.equal(hasUpdate(s, undefined), false);
  assert.deepEqual(changesSince("1.4.2", latest).map((e) => e.version), ["1.5.0", "1.4.10"]);
  assert.deepEqual(changesSince("1.5.0", latest), []);
});

test("pluginCommands / commandUsage / attachable:只列已启用、挂在本聊天的插件命令", () => {
  const gmail = mf({ id: "g-group.gmail", name: "Gmail", category: "outbound", contributes: { commands: [cmd("mail")], panels: [], events: [] } });
  const cve = mf({ id: "g-group.cve", name: "CVE 订阅", contributes: { commands: [cmd("cve")], panels: [], events: [] } });
  const hook = mf({ id: "g-group.webhook", name: "Webhook", contributes: { commands: [cmd("hook")], panels: [], events: [] } });
  const installs = [
    seedInstalled(mf({}), { enabled: true, convs: ["g"], callers: ["argon"] }),
    seedInstalled(gmail, { enabled: true, convs: ["g-design"], callers: [] }),
    seedInstalled(cve, { enabled: false, convs: ["g"], callers: [] }),
    seedInstalled(hook, { enabled: true, convs: [], callers: [] }),
    notInstalled("g-group.board"),
  ];
  assert.deepEqual(pluginCommands(installs, "g").map((c) => [c.command.name, c.plugin, c.pluginName]), [["feishu", "g-group.feishu", "飞书"]]);
  assert.deepEqual(pluginCommands(installs).map((c) => c.command.name), ["feishu", "hook", "mail"]);
  assert.equal(commandUsage(mf({}).contributes.commands[0]!), "/feishu <群名> [条数]");
  assert.equal(commandUsage(cmd("mail")), "/mail");
  assert.deepEqual(attachable(installs, "g").map((s) => s.id), ["g-group.gmail", "g-group.webhook"]);
  assert.deepEqual(attachable(installs, "g-design").map((s) => s.id), ["g-group.feishu", "g-group.cve", "g-group.webhook"]);
});

// ---------------------------------------------------------------- 市场

const CATALOG: PluginManifest[] = [
  mf({ version: "1.5.0", changelog: [{ version: "1.5.0", date: "2026-11-02", notes: ["能读飞书文档"] }] }),
  mf({ id: "g-group.gmail", name: "Gmail", category: "outbound", version: "2.1.0", summary: "替助手发邮件,收件人要预先授权", contributes: { commands: [cmd("mail")], panels: [], events: [] }, changelog: [{ version: "2.1.0", date: "2026-08-01", notes: [] }] }),
  mf({ id: "g-group.board", name: "看板面板", category: "ui", version: "0.4.0", summary: "在群右侧加一块看板", contributes: { commands: [cmd("board")], panels: [], events: [] }, changelog: [{ version: "0.4.0", date: "2026-10-20", notes: [] }] }),
  mf({ id: "g-group.translate", name: "翻译", category: "command", version: "1.0.0", summary: "把选中的消息翻译成别的语言", contributes: { commands: [cmd("translate")], panels: [], events: [] }, changelog: [{ version: "1.0.0", date: "2026-07-15", notes: [] }] }),
  mf({ id: "g-group.cve", name: "CVE 订阅", category: "source", version: "1.3.0", summary: "有新漏洞公告就推给挂了它的助手", contributes: { commands: [cmd("cve")], panels: [], events: [] }, changelog: [{ version: "1.3.0", date: "2026-10-28", notes: [] }] }),
  mf({ id: "acme.archive", name: "消息归档", publisher: "Acme", category: "command", version: "0.2.0", summary: "把聊天存档到本地", contributes: { commands: [cmd("archive")], panels: [], events: [] }, changelog: [{ version: "0.2.0", date: "2026-09-01", notes: [] }] }),
];
const NOTES = mf({ id: "acme.notes", name: "笔记", publisher: "Acme", category: "command", version: "0.1.0", summary: "从文件装的本地插件", contributes: { commands: [cmd("note")], panels: [], events: [] }, changelog: [{ version: "0.1.0", date: "2026-11-05", notes: [] }] });
const INSTALLS = [
  seedInstalled(mf({}), { enabled: true, convs: ["g"], callers: [] }),
  seedInstalled(CATALOG[1]!, { enabled: false, convs: [], callers: [] }),
  seedInstalled(mf({ id: "g-group.cve", name: "CVE 订阅", version: "1.2.0" }), { enabled: true, convs: [], callers: [] }),
  seedInstalled(NOTES, { enabled: true, convs: [], callers: [] }),
];
const Q = { text: "", category: "all", filter: "all", sort: "featured" } as const;
const ids = (xs: { manifest: PluginManifest }[]) => xs.map((x) => x.manifest.id);

test("marketList:按名称、简介、命令名搜,命令名带不带 / 都行,名称命中排前面", () => {
  assert.deepEqual(marketList(CATALOG, INSTALLS, { ...Q, text: "飞书" }).map((x) => [x.manifest.id, x.matched]), [["g-group.feishu", ["name", "summary"]]]);
  assert.deepEqual(marketList(CATALOG, INSTALLS, { ...Q, text: "邮件" }).map((x) => [x.manifest.id, x.matched]), [["g-group.gmail", ["summary"]]]);
  assert.deepEqual(marketList(CATALOG, INSTALLS, { ...Q, text: "/translate" }).map((x) => [x.manifest.id, x.matched]), [["g-group.translate", ["command"]]]);
  assert.deepEqual(marketList(CATALOG, INSTALLS, { ...Q, text: " MAIL " }).map((x) => [x.manifest.id, x.matched]), [["g-group.gmail", ["name", "command"]]]);
  // 「消息」:消息归档名称命中排第一,其余简介命中按目录顺序
  assert.deepEqual(ids(marketList(CATALOG, INSTALLS, { ...Q, text: "消息" })), ["acme.archive", "g-group.feishu", "g-group.translate"]);
  assert.deepEqual(marketList(CATALOG, INSTALLS, { ...Q, text: "没有这个" }), []);
});

test("marketList:按类别、已安装、有更新筛选,带出已装版本和更新标记", () => {
  assert.deepEqual(ids(marketList(CATALOG, INSTALLS, { ...Q, category: "source" })), ["g-group.feishu", "g-group.cve"]);
  assert.deepEqual(ids(marketList(CATALOG, INSTALLS, { ...Q, category: "command", text: "消息" })), ["acme.archive", "g-group.translate"]);
  assert.deepEqual(
    marketList(CATALOG, INSTALLS, { ...Q, filter: "installed" }).map((x) => [x.manifest.id, x.phase, x.installedVersion, x.hasUpdate]),
    [
      ["g-group.feishu", "enabled", "1.4.2", true],
      ["g-group.gmail", "disabled", "2.1.0", false],
      ["g-group.cve", "enabled", "1.2.0", true],
      ["acme.notes", "enabled", "0.1.0", false],
    ],
  );
  assert.deepEqual(marketList(CATALOG, INSTALLS, { ...Q, filter: "updates" }).map((x) => [x.manifest.id, x.manifest.version, x.installedVersion]), [
    ["g-group.feishu", "1.5.0", "1.4.2"],
    ["g-group.cve", "1.3.0", "1.2.0"],
  ]);
  const board = marketList(CATALOG, INSTALLS, { ...Q, category: "ui" });
  assert.deepEqual(board.map((x) => [x.manifest.id, x.phase, x.installedVersion, x.hasUpdate, x.install]), [["g-group.board", "not_installed", null, false, null]]);
});

test("marketList:按名称(中文按拼音)和最近更新排序", () => {
  assert.deepEqual(marketList(CATALOG, INSTALLS, { ...Q, sort: "name" }).map((x) => x.manifest.name), ["笔记", "翻译", "飞书", "看板面板", "消息归档", "CVE 订阅", "Gmail"]);
  assert.deepEqual(ids(marketList(CATALOG, INSTALLS, { ...Q, sort: "updated" })), ["acme.notes", "g-group.feishu", "g-group.cve", "g-group.board", "acme.archive", "g-group.gmail", "g-group.translate"]);
});

test("marketCounts:总数、已安装、有更新、各类别数", () => {
  assert.deepEqual(marketCounts(CATALOG, INSTALLS), { all: 7, installed: 4, updates: 2, byCategory: { source: 2, outbound: 1, ui: 1, command: 3 } });
  assert.deepEqual(marketCounts(CATALOG, []), { all: 6, installed: 0, updates: 0, byCategory: { source: 2, outbound: 1, ui: 1, command: 2 } });
});
