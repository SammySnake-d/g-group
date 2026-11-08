// 真实模型冒烟(不在测试 glob 内,手动跑):
//   node packages/adapter-pi-contact/scripts/smoke.ts
// 从环境变量读端点配置:ANTHROPIC_BASE_URL、ANTHROPIC_AUTH_TOKEN(按 Bearer 发)或 ANTHROPIC_API_KEY(按 x-api-key 发)、
// ANTHROPIC_DEFAULT_SONNET_MODEL。读环境变量的是这个脚本(调用方),适配器本身不读。
// 跑一轮:第 4 块是用户私聊「帮我在 /tmp/gg-smoke 下写一个 hello.txt，内容 hi」,期望模型调 dispatch_compute。
// 输出只有动作列表、状态笔记、耗时与判定;不打印端点地址和密钥。适配器不做 I/O,所以不会真的写文件。
import { BLOCK_LABELS, type BlockNo, type RoundBlock, type RoundInput } from "@g-group/kernel";
import { createPiContactMind } from "../src/index.ts";

const baseUrl = process.env.ANTHROPIC_BASE_URL;
const token = process.env.ANTHROPIC_AUTH_TOKEN;
const apiKey = token || process.env.ANTHROPIC_API_KEY;
const model = process.env.ANTHROPIC_DEFAULT_SONNET_MODEL;
if (!baseUrl || !apiKey || !model) {
  console.error("缺环境变量:需要 ANTHROPIC_BASE_URL、ANTHROPIC_AUTH_TOKEN 或 ANTHROPIC_API_KEY、ANTHROPIC_DEFAULT_SONNET_MODEL");
  process.exit(2);
}

const ROOM = "dm:u-boss";
const text: Record<BlockNo, string> = {
  1: [
    "你是联系人「小后」,在 g-group 里替用户办事。",
    "你只能通过工具行动:reply 发言、dispatch_compute 开 Compute 干活、commit 登记承诺、forward/deliver/stop 处理在途任务、update_state_note 写状态笔记。",
    "你自己没有 shell、文件读写或网络工具;凡是要写文件、跑命令、改代码的事,都用 dispatch_compute 交给 Compute,不要自己假装做完。",
    "直接输出的文字不会发给任何人,要对用户说话就用 reply。",
    "人设:说话简短、靠谱。",
  ].join("\n"),
  2: "(没有未了结的承诺)",
  3: "(还没有状态笔记)",
  4: `会话 ${ROOM}(与用户的私聊)\n#12 user:u-boss(老板) 2026-11-08T22:30:00+08:00:帮我在 /tmp/gg-smoke 下写一个 hello.txt，内容 hi`,
  5: "(没有需要换入的旧消息)",
};
const blocks: RoundBlock[] = ([1, 2, 3, 4, 5] as const).map((n) => ({ block: n, label: BLOCK_LABELS[n], text: text[n], cacheBreakpoint: n === 1 }));
const input: RoundInput = {
  contact: { id: "c-xiaohou", name: "小后", speakingModel: model, persona: "说话简短、靠谱" },
  request: { blocks, basedOnSeq: { [ROOM]: 12 } },
  fresh: [],
};

const mind = createPiContactMind({ provider: "smoke", model, baseUrl, apiKey, authHeader: token ? "bearer" : "x-api-key", maxTokens: 2048 });
const started = Date.now();
try {
  const out = await mind.round(input, AbortSignal.timeout(120_000));
  const dispatched = out.actions.some((a) => a.kind === "dispatch");
  console.log(JSON.stringify({ model, ms: Date.now() - started, actions: out.actions, stateNote: out.stateNote, dispatched }, null, 2));
  process.exit(dispatched ? 0 : 1);
} catch (e) {
  const err = e as { name?: string; code?: string; message?: string };
  // 端点地址里可能嵌着网关凭据,打印前一并隐去(密钥已由适配器隐去)
  const message = String(err.message ?? "").split(baseUrl).join("[端点已隐去]");
  console.log(JSON.stringify({ model, ms: Date.now() - started, error: { name: err.name, code: err.code, message } }, null, 2));
  process.exit(1);
}
