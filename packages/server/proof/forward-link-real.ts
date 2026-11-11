// 真实运行(feat/forward-link;U25/U24/US2、AC-20):真实联系人脑子(pi,真模型)+ 真实 SQLite,真实服务层入口。
// 场景:私聊里与小克约定日期 → 选两条私聊消息转发进「项目群」→ 群里 @小研 按刚转发的两条办(它复述得出副本内容);
// 关联前先在群里问私聊约定的日期(阴性对照:读不到,应说不知道)→ rooms.link 把私聊关联到群 → 再问一次,
// 这次只能经 read_linked 读到私聊记录(关联之后没有任何别的通道把私聊内容送进群)。
// 网关地址、令牌与模型只经环境变量(ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_DEFAULT_SONNET_MODEL),不落盘、不打印。
// 用法:node packages/server/proof/forward-link-real.ts <数据目录>
import { mkdirSync } from "node:fs";
import path from "node:path";
import { type ServerEvent, checkResult } from "@g-group/api-contract";
import { startServer } from "../src/start.ts";

const root = path.resolve(process.argv[2] ?? "/tmp/gg-fwdlink-real");
mkdirSync(root, { recursive: true });
const model = process.env.ANTHROPIC_DEFAULT_SONNET_MODEL ?? "(未设置)";
const started = await startServer({ dataDir: root, mind: "pi", onReport: (what, detail) => console.log(`[宿主] ${what} ${JSON.stringify(detail).slice(0, 300)}`) });
const svc = started.service;
const host = started.host;
const seen: string[] = [];
host.bus.subscribe((e: ServerEvent) => {
  if (e.type === "message.appended") seen.push(`#${e.message.seq} ${e.message.sender.kind === "user" ? "我" : "联系人"}: ${e.message.text.slice(0, 400)}`);
});

async function call<T>(method: string, params: unknown): Promise<T> {
  const r = await svc.handle(method as never, params);
  if (!r.ok) throw new Error(`${method}:${r.error.code} ${r.error.message}`);
  const checked = checkResult(method as never, r.value);
  if (!checked.ok) throw new Error(`${method} 结果不合合同`);
  return r.value as T;
}
const settle = async (ms: number) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    await host.idle();
    await new Promise((r) => setTimeout(r, 500));
  }
};
const say = async (roomId: string, text: string, mentions?: { id: string; source: "manual" }[]) => {
  const m = await call<{ seq: number }>("messages.send", { roomId, clientActionId: `u-${Math.random().toString(36).slice(2, 10)}`, text, ...(mentions ? { mentions } : {}) });
  await settle(180_000);
  return m;
};
const lastContactText = async (roomId: string) => {
  const page = await call<{ messages: { seq: number; sender: { kind: string }; text: string }[] }>("messages.list", { roomId, limit: 50 });
  return page.messages.filter((m) => m.sender.kind === "contact").at(-1)?.text ?? "(联系人没有回话)";
};

console.log(`# ${new Date().toISOString()} 模型 ${model};真实联系人脑子 mind=pi,真实 SQLite,数据目录 ${root}`);
const keke = await call<{ id: string }>("contacts.create", { clientActionId: "c-keke", name: "小克", bio: "工程师", persona: "你是用户的老朋友兼工程师,回答简短。" });
const yan = await call<{ id: string }>("contacts.create", { clientActionId: "c-yan", name: "小研", bio: "研究员", persona: "你是研究员,回答简短;不知道就直说不知道。" });
const dm = await call<{ id: string }>("rooms.openDm", { contactId: keke.id });
const group = await call<{ id: string }>("rooms.createGroup", { clientActionId: "g1", title: "项目群", members: [{ kind: "contact", id: yan.id }] });

// ① 私聊里约定两件事
await say(dm.id, "私下约定:交付日期是 12 月 3 日。");
await say(dm.id, "另一条:发布流程先跑 smoke 再发。回个收到。");
const dmMsgs = (await call<{ messages: { seq: number; sender: { kind: string }; text: string }[] }>("messages.list", { roomId: dm.id, limit: 50 })).messages;
const picked = dmMsgs.filter((m) => m.sender.kind === "user").slice(-2);
console.log(`# 选中私聊里的 #${picked.map((m) => m.seq).join(" #")} 转发到群`);

// ② 转发进群
const fwd = await call<{ seq: number; forwarded?: { fromRoomId: string; fromTitle: string; items: { seq: number; text: string; sourceRetracted: boolean }[] }; mentions: unknown[]; command: unknown }>("messages.forward", {
  fromRoomId: dm.id,
  seqs: picked.map((m) => m.seq),
  toRoomId: group.id,
  note: "看看这两条",
  clientActionId: "fwd-1",
});
console.log(`# 群里的副本 #${fwd.seq}:来源 ${fwd.forwarded?.fromTitle}(${fwd.forwarded?.fromRoomId}),条目 ${JSON.stringify(fwd.forwarded?.items.map((i) => i.text))},mentions=${JSON.stringify(fwd.mentions)},command=${JSON.stringify(fwd.command)}`);
console.log(`# 副本正文:\n${(await call<{ messages: { seq: number; text: string }[] }>("messages.list", { roomId: group.id, limit: 50 })).messages.find((m) => m.seq === fwd.seq)?.text}`);
await say(group.id, "@小研 按我刚转发的两条办,先复述一下是哪两条。", [{ id: yan.id, source: "manual" }]);
const repeat = await lastContactText(group.id);
console.log(`# 小研复述(应说出副本里的两条):${repeat.slice(0, 500)}`);
console.log(`# 复述里出现日期 12 月 3 = ${/12\s*月\s*3/.test(repeat)};出现 smoke = ${/smoke/i.test(repeat)}`);

// ③ 阴性对照:关联前问私聊约定的日期
await say(group.id, "@小研 我们私聊里约定的交付日期是哪天?如果你不知道就直接说不知道。", [{ id: yan.id, source: "manual" }]);
const before = await lastContactText(group.id);
console.log(`# 关联前小研的回答(应说不知道;此刻它没有读私聊的通道):${before.slice(0, 400)}`);

// ④ 关联私聊到群,再问一次
const linked = await call<{ linkedRooms?: { roomId: string; uptoSeq: number }[] }>("rooms.link", { roomId: group.id, linkedRoomId: dm.id, clientActionId: "link-1" });
console.log(`# 关联结果:${JSON.stringify(linked.linkedRooms)}`);
await say(group.id, "@小研 现在再答一次:我们私聊里约定的交付日期是哪天?用 read_linked 读关联的私聊记录。", [{ id: yan.id, source: "manual" }]);
const after = await lastContactText(group.id);
console.log(`# 关联后小研的回答(应说出 12 月 3 日):${after.slice(0, 400)}`);
console.log(`# 关联后出现日期 12 月 3 = ${/12\s*月\s*3/.test(after)}`);

// ⑤ 解除关联后再问一次(应又读不到)
await call("rooms.unlink", { roomId: group.id, linkedRoomId: dm.id, clientActionId: "unlink-1" });
await say(group.id, "@小研 再答一次:私聊约定的交付日期是哪天?不知道就说不知道。", [{ id: yan.id, source: "manual" }]);
const off = await lastContactText(group.id);
console.log(`# 解除关联后小研的回答:${off.slice(0, 400)}`);

console.log("—— 会话 ——");
for (const line of seen) console.log(`  ${line}`);
await started.close();
console.log("# 结束");
