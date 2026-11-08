import assert from "node:assert/strict";
import { test } from "node:test";
import {
  availableCommands,
  checkCommand,
  completeToken,
  detectSlash,
  filterCommands,
  formatUsage,
  isCommandName,
  looksLikeTime,
  matchTier,
  parseInvocation,
  parseSource,
  removeToken,
  scheduleHint,
  type SlashCommand,
  toRunParams,
} from "./slash.ts";

const cmd = (name: string, title: string, desc: string, extra: Partial<SlashCommand> = {}): SlashCommand => ({ name, title, desc, args: [], source: "builtin", scope: "any", ...extra });

const summary = cmd("summary", "总结未读", "把你不在时的消息总结成几条", { scope: "group" });
const schedule = cmd("schedule", "定时", "到点叫某个助手做一件事", {
  args: [
    { name: "何时", kind: "time", required: true, hint: "每天 9:00、工作日 18:30 或 cron" },
    { name: "做什么", kind: "text", required: true, rest: true, hint: "醒来要做的事" },
  ],
});
const todo = cmd("todo", "加到清单", "把一件事加进群清单", { scope: "group", args: [{ name: "内容", kind: "text", required: true, rest: true, hint: "要做的事" }] });
const notice = cmd("notice", "改群公告", "把群公告换成你写的这段", { scope: "group", args: [{ name: "内容", kind: "text", required: true, rest: true, hint: "新公告" }] });
const handoff = cmd("handoff", "交给助手", "@ 一位助手,把一件事交给它", {
  scope: "group",
  args: [
    { name: "谁", kind: "person", required: true, hint: "@ 某位助手" },
    { name: "事", kind: "text", required: true, rest: true, hint: "要它做什么" },
  ],
});
const files = cmd("files", "群文件", "看本群发过的文件");
const pins = cmd("pins", "记下的事", "助手答应过、记在本群的事");
const feishu = cmd("feishu", "引用飞书消息", "从飞书群里勾几条带进对话", { source: "plugin:p-feishu" });
const mail = cmd("mail", "发邮件", "让有授权的助手替你发邮件", { source: "plugin:p-gmail", args: [{ name: "收件人", kind: "text", required: true, hint: "邮箱" }] });
const review = cmd("review", "代码审查", "请 Claude Code 审查一段改动", { source: "assistant:claude", args: [{ name: "看什么", kind: "text", required: true, rest: true, hint: "分支或文件" }] });
const deploy = cmd("deploy", "发布", "把分支发布到环境", {
  args: [
    { name: "环境", kind: "choice", required: true, options: ["staging", "prod"], hint: "staging 或 prod" },
    { name: "份数", kind: "number", required: false, hint: "几台" },
  ],
});
const ALL = [summary, schedule, todo, notice, handoff, files, pins, feishu, mail, review, deploy];

test("isCommandName:小写字母数字和 -,不以 - 开头结尾,不超过 32 个字符", () => {
  assert.equal(isCommandName("summary"), true);
  assert.equal(isCommandName("to-do2"), true);
  assert.equal(isCommandName("Todo"), false);
  assert.equal(isCommandName("-todo"), false);
  assert.equal(isCommandName("todo-"), false);
  assert.equal(isCommandName("定时"), false);
  assert.equal(isCommandName("a b"), false);
  assert.equal(isCommandName(""), false);
  assert.equal(isCommandName("a".repeat(33)), false);
  assert.equal(isCommandName("a".repeat(32)), true);
});

test("parseSource:拆出内置 / 插件 id / 助手 id,写错的认不出", () => {
  assert.deepEqual(parseSource("builtin"), { kind: "builtin" });
  assert.deepEqual(parseSource("plugin:p-feishu"), { kind: "plugin", id: "p-feishu" });
  assert.deepEqual(parseSource("assistant:claude"), { kind: "assistant", id: "claude" });
  assert.equal(parseSource("plugin:"), undefined);
  assert.equal(parseSource("bot:x"), undefined);
  assert.equal(parseSource("plugin:a b"), undefined);
});

test("checkCommand:合法定义没有问题;名字、来源、参数顺序、选项、剩余文本各自报出来", () => {
  assert.deepEqual(checkCommand(schedule), []);
  assert.deepEqual(checkCommand(deploy), []);
  const bad = checkCommand({
    name: "Bad Name", title: " ", desc: "", source: "bot:x" as "builtin", scope: "room" as "any",
    args: [
      { name: "a", kind: "text", required: false, rest: true, hint: "" },
      { name: "a", kind: "choice", required: true, hint: "" },
      { name: "c", kind: "date" as "time", required: true, hint: "" },
    ],
  });
  assert.deepEqual(bad, [
    "命令名「Bad Name」只能用小写字母、数字和 -",
    "/Bad Name 缺中文名",
    "/Bad Name 的来源「bot:x」认不出",
    "/Bad Name 的范围「room」认不出",
    "/Bad Name 的参数「a」吞掉剩余文本,只能放最后",
    "/Bad Name 的参数「a」重复",
    "/Bad Name 的参数「a」是选项,但没给可选值",
    "/Bad Name 的必填参数「a」不能排在可选参数后面",
    "/Bad Name 的参数「c」类型「date」认不出",
    "/Bad Name 的必填参数「c」不能排在可选参数后面",
  ]);
});

test("availableCommands:按群/私聊、挂着的插件、在场的助手筛;同名内置优先;内置→插件→助手", () => {
  const dupe = cmd("files", "飞书文件", "飞书里的文件", { source: "plugin:p-feishu" });
  const broken = cmd("Oops", "坏的", "名字不合法");
  const list = [review, feishu, dupe, summary, broken, mail, files];
  const inGroup = availableCommands(list, { scope: "group", plugins: ["p-feishu"], assistants: ["claude"] });
  assert.deepEqual(inGroup.map((c) => `${c.name}@${c.source}`), ["summary@builtin", "files@builtin", "feishu@plugin:p-feishu", "review@assistant:claude"]);
  const inDm = availableCommands(list, { scope: "dm", plugins: ["p-gmail"], assistants: [] });
  assert.deepEqual(inDm.map((c) => c.name), ["files", "mail"]);
});

test("detectSlash:开头或空白后的 /xxx 才算,返回前缀和替换范围", () => {
  assert.deepEqual(detectSlash("/", 1), { start: 0, end: 1, query: "" });
  assert.deepEqual(detectSlash("/sch", 4), { start: 0, end: 4, query: "sch" });
  assert.deepEqual(detectSlash("买牛奶 /to", 7), { start: 4, end: 7, query: "to" });
  assert.deepEqual(detectSlash("第一行\n/定时", 7), { start: 4, end: 7, query: "定时" });
  // 光标在词中间:前缀只取到光标,替换范围到词尾
  assert.deepEqual(detectSlash("/schedule 每天", 4), { start: 0, end: 9, query: "sch" });
  // 中文输入法:全角/任意位置都认,「、」只认整段开头
  assert.deepEqual(detectSlash("／todo", 5), { start: 0, end: 5, query: "todo" });
  assert.deepEqual(detectSlash("、定时", 3), { start: 0, end: 3, query: "定时" });
  assert.equal(detectSlash("苹果 、香蕉", 6), null);
});

test("detectSlash:网址、路径、词中间的 / 和光标不在词上都不弹", () => {
  assert.equal(detectSlash("https://example.com/a", 21), null);
  assert.equal(detectSlash("看 http://x.cn/s", 15), null);
  assert.equal(detectSlash("1/2", 3), null);
  assert.equal(detectSlash("打开 /tmp/a", 9), null);
  assert.equal(detectSlash("//", 2), null);
  assert.equal(detectSlash("/todo ", 6), null);
  assert.equal(detectSlash("/todo", 9), null);
  assert.equal(detectSlash("", 0), null);
});

test("matchTier:名字完全相同 0、前缀 1、名字或中文名包含 2、子序列 3、说明 4、不匹配 -1", () => {
  assert.equal(matchTier(todo, "todo"), 0);
  assert.equal(matchTier(schedule, "sch"), 1);
  assert.equal(matchTier(schedule, "edu"), 2);
  assert.equal(matchTier(schedule, "定时"), 2);
  assert.equal(matchTier(schedule, "sdl"), 3);
  assert.equal(matchTier(schedule, "助手"), 4);
  assert.equal(matchTier(schedule, "xyz"), -1);
  assert.equal(matchTier(schedule, "SCH"), 1);
});

test("filterCommands:前缀 > 包含 > 模糊 > 说明,同档按原顺序;中文名和说明也能搜;空输入全给", () => {
  const list = [summary, schedule, todo, notice, handoff, files, pins, feishu];
  assert.deepEqual(filterCommands(list, "sch").map((c) => c.name), ["schedule"]);
  assert.deepEqual(filterCommands(list, "定时").map((c) => c.name), ["schedule"]);
  assert.deepEqual(filterCommands(list, "公告").map((c) => c.name), ["notice"]);
  assert.deepEqual(filterCommands(list, "飞书").map((c) => c.name), ["feishu"]);
  // s 前缀:summary schedule;名字里含 s:files pins feishu;todo notice handoff 都没有 s
  assert.deepEqual(filterCommands(list, "s").map((c) => c.name), ["summary", "schedule", "files", "pins", "feishu"]);
  // 子序列:sdl 只在 schedule 里按顺序出现
  assert.deepEqual(filterCommands(list, "sdl").map((c) => c.name), ["schedule"]);
  // 「群」:中文名包含的(改群公告、群文件)排在只有说明包含的(加到清单、记下的事、引用飞书消息)前面
  assert.deepEqual(filterCommands(list, "群").map((c) => c.name), ["notice", "files", "todo", "pins", "feishu"]);
  assert.deepEqual(filterCommands(list, "").map((c) => c.name), ["summary", "schedule", "todo", "notice", "handoff", "files", "pins", "feishu"]);
  assert.deepEqual(filterCommands(list, "zzz"), []);
});

test("formatUsage:必填用 <>,可选用 []", () => {
  assert.equal(formatUsage(schedule), "/schedule <何时> <做什么>");
  assert.equal(formatUsage(deploy), "/deploy <环境> [份数]");
  assert.equal(formatUsage(summary), "/summary");
});

test("completeToken:换成 /name 加空格;片段前已有字时把命令挪到开头,原来的字当参数", () => {
  assert.deepEqual(completeToken("/sch", { start: 0, end: 4, query: "sch" }, "schedule"), { text: "/schedule ", cursor: 10 });
  assert.deepEqual(completeToken("/sc 每天", { start: 0, end: 3, query: "sc" }, "schedule"), { text: "/schedule 每天", cursor: 10 });
  assert.deepEqual(completeToken("买牛奶 /to", { start: 4, end: 7, query: "to" }, "todo"), { text: "/todo 买牛奶", cursor: 9 });
  assert.deepEqual(completeToken("买牛奶 /to 和面包", { start: 4, end: 7, query: "to" }, "todo"), { text: "/todo 买牛奶 和面包", cursor: 13 });
});

test("removeToken:不带参数的命令选中即执行,输入框里只去掉片段", () => {
  assert.deepEqual(removeToken("/summary", { start: 0, end: 8, query: "summary" }), { text: "", cursor: 0 });
  assert.deepEqual(removeToken("先看下 /fi 再说", { start: 4, end: 7, query: "fi" }), { text: "先看下 再说", cursor: 4 });
  assert.deepEqual(removeToken("先看下 /fi", { start: 4, end: 7, query: "fi" }), { text: "先看下", cursor: 3 });
});

test("parseInvocation:不是命令、不认识的命令返回 null;大小写和前导空白不影响", () => {
  assert.equal(parseInvocation("你好", ALL), null);
  assert.equal(parseInvocation("/nope 1", ALL), null);
  assert.equal(parseInvocation("http://a/b", ALL), null);
  assert.equal(parseInvocation("", ALL), null);
  assert.equal(parseInvocation("  /TODO 买菜", ALL)?.values.内容, "买菜");
  assert.equal(parseInvocation("、todo 买菜", ALL)?.command.name, "todo");
});

test("parseInvocation:/schedule 逐步输入时,当前该填的参数一格格往后走", () => {
  const steps = ["/schedule", "/schedule ", "/schedule 每天9", "/schedule 每天9点 ", "/schedule 每天9点 写日", "/schedule 每天9点 写日报 "].map((t) => {
    const r = parseInvocation(t, ALL)!;
    return [r.current, r.typing, r.missing.join(","), r.ok];
  });
  assert.deepEqual(steps, [
    [0, false, "何时,做什么", false],
    [0, false, "何时,做什么", false],
    [0, true, "做什么", false],
    [1, false, "做什么", false],
    [1, true, "", true],
    [-1, false, "", true],
  ]);
  const r = parseInvocation("/schedule 每天9点 写日报 和周报", ALL)!;
  assert.deepEqual(r.values, { 何时: "每天9点", 做什么: "写日报 和周报" });
  assert.deepEqual(r.args.map((a) => a.value), ["每天9点", "写日报 和周报"]);
});

test("parseInvocation:引号包住带空格的文本,中英文引号都认;没闭合的引号算还在输入", () => {
  const r = parseInvocation('/schedule "工作日 18:30" 写周报', ALL)!;
  assert.deepEqual(r.values, { 何时: "工作日 18:30", 做什么: "写周报" });
  assert.equal(r.ok, true);
  const cn = parseInvocation("/schedule “0 9 * * 1-5” 「看 报错」", ALL)!;
  assert.deepEqual(cn.values, { 何时: "0 9 * * 1-5", 做什么: "看 报错" });
  const open = parseInvocation('/schedule "工作日 18', ALL)!;
  assert.equal(open.current, 0);
  assert.equal(open.typing, true);
  assert.equal(open.values.何时, "工作日 18");
  const restOpen = parseInvocation('/todo "买 牛', ALL)!;
  assert.equal(restOpen.typing, true);
  assert.equal(restOpen.values.内容, "买 牛");
});

test("parseInvocation:@ 人名可以带空格,按名单最长匹配并规范大小写;不在名单里报错", () => {
  const people = ["Claude", "Claude Code", "Argon"];
  const r = parseInvocation("/handoff @Claude Code 修首页 性能", ALL, { people })!;
  assert.deepEqual(r.values, { 谁: "Claude Code", 事: "修首页 性能" });
  assert.equal(r.ok, true);
  const lower = parseInvocation("/handoff @argon 整理需求", ALL, { people })!;
  assert.equal(lower.values.谁, "Argon");
  const nobody = parseInvocation("/handoff @Bob 干活", ALL, { people })!;
  assert.deepEqual(nobody.errors, ["这里没有叫「Bob」的成员"]);
  assert.equal(nobody.ok, false);
  const noList = parseInvocation("/handoff @Bob 干活", ALL)!;
  assert.equal(noList.values.谁, "Bob");
  assert.equal(noList.ok, true);
});

test("parseInvocation:choice 只认可选值(规范大小写)、number 要数字、time 要看得懂、多余文字报出来", () => {
  const okd = parseInvocation("/deploy PROD 3", ALL)!;
  assert.deepEqual(okd.values, { 环境: "prod", 份数: "3" });
  assert.equal(okd.ok, true);
  const badChoice = parseInvocation("/deploy dev", ALL)!;
  assert.deepEqual(badChoice.errors, ["「环境」只能是 staging / prod"]);
  const badNum = parseInvocation("/deploy prod 三", ALL)!;
  assert.deepEqual(badNum.errors, ["「份数」要填数字"]);
  const badTime = parseInvocation("/schedule 回头 写日报", ALL)!;
  assert.deepEqual(badTime.errors, ["「何时」看不懂,试试 每天 9:00、工作日 18:30 或 0 9 * * 1-5"]);
  const extra = parseInvocation("/deploy prod 2 马上", ALL)!;
  assert.deepEqual(extra.errors, ["多了「马上」"]);
  assert.equal(extra.current, -1);
  const noArgs = parseInvocation("/summary 快点", ALL)!;
  assert.deepEqual(noArgs.errors, ["/summary 不带参数,多了「快点」"]);
  const empty = parseInvocation('/todo ""', ALL)!;
  assert.deepEqual(empty.missing, ["内容"]);
  assert.equal(parseInvocation("/summary", ALL)!.ok, true);
});

test("looksLikeTime:钟点、cron 五段、每天/工作日/明天这类说法算时间,别的不算", () => {
  assert.equal(looksLikeTime("9:30"), true);
  assert.equal(looksLikeTime("下午3点"), true);
  assert.equal(looksLikeTime("两点"), true);
  assert.equal(looksLikeTime("0 9 * * 1-5"), true);
  assert.equal(looksLikeTime("工作日"), true);
  assert.equal(looksLikeTime("明天"), true);
  assert.equal(looksLikeTime("每2小时"), true);
  assert.equal(looksLikeTime("回头"), false);
  assert.equal(looksLikeTime("a b c d e"), false);
  assert.equal(looksLikeTime(" "), false);
});

test("scheduleHint:把「何时」翻成定时编辑器的预填(钟点、重复;cron 原样带上)", () => {
  assert.deepEqual(scheduleHint("每天9点"), { time: "09:00", repeat: "每天" });
  assert.deepEqual(scheduleHint("工作日 18:30"), { time: "18:30", repeat: "工作日" });
  assert.deepEqual(scheduleHint("每周一下午3点半"), { time: "15:30", repeat: "每周一" });
  assert.deepEqual(scheduleHint("明天 8点15"), { time: "08:15", repeat: "一次" });
  assert.deepEqual(scheduleHint("0 9 * * 1-5"), { cron: "0 9 * * 1-5", time: "09:00", repeat: "工作日" });
  assert.deepEqual(scheduleHint("30 7 * * *"), { cron: "30 7 * * *", time: "07:30", repeat: "每天" });
  assert.deepEqual(scheduleHint("*/15 * * * *"), { cron: "*/15 * * * *" });
  assert.deepEqual(scheduleHint("周末"), {});
});

test("toRunParams:交给后端的执行参数是纯数据,和解析结果脱钩", () => {
  const inv = parseInvocation("/todo 买一台测试机", ALL)!;
  const p = toRunParams(inv, "g");
  assert.deepEqual(p, { conv: "g", command: "todo", source: "builtin", values: { 内容: "买一台测试机" } });
  p.values.内容 = "改掉";
  assert.equal(inv.values.内容, "买一台测试机");
});
