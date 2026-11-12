// P7: 真实隔离插件与生产 service 入口；每条测试都按实际状态判，不把假注册表当插件执行。
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, afterEach, test } from "node:test";
import type { MessageView, SlashCommand } from "@g-group/api-contract";
import { all } from "./db.ts";
import { scriptedCompute, scriptedMind } from "./fakes.ts";
import { Host } from "./host.ts";
import { createService } from "./service.ts";
import { cleanupKit, closeKitHosts, setup } from "./test-kit.ts";

afterEach(() => closeKitHosts());
after(() => cleanupKit());

const ketchupPath = fileURLToPath(new URL("../plugins/ketchup", import.meta.url));
type Kit = ReturnType<typeof setup>;
async function install(s: Kit, dir: string, granted = ["chat:read"]) {
  const r = await s.svc.handle("plugins.install", { clientActionId: `install-${dir}`, source: { kind: "local-path", path: dir }, grantedPermissions: granted });
  assert.ok(r.ok, JSON.stringify(r));
}
function fixture(s: Kit, id: string, command: string, body: string, permission = true) {
  const dir = path.join(s.root, `pkg-${id}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "plugin.json"), JSON.stringify({ id, name: id, version: "1.0.0", publisher: "fixture", description: "", kinds: ["ui-extension"], entry: "index.mjs", permissions: permission ? [{ key: "chat:read", description: "本次选中会话只读快照" }] : [], commands: [{ name: command, description: command, args: [] }] }));
  writeFileSync(path.join(dir, "index.mjs"), `let calls = 0; export default {kind:"ui-extension", async command(req) { calls++; ${body} }};`);
  return dir;
}
const send = (roomId: string, clientActionId: string, name: string, args: Record<string, unknown> = {}) => ({ roomId, clientActionId, text: `/${name}`, command: { name, args } });
const view = (r: Awaited<ReturnType<Kit["svc"]["handle"]>>) => { assert.ok(r.ok, JSON.stringify(r)); return r.value as MessageView; };
const state = (host: Host) => ({ cursors: all(host.db, "SELECT * FROM gg_cursor ORDER BY contact_id, room_id"), read: all(host.db, "SELECT * FROM gg_read"), inputs: all(host.db, "SELECT * FROM gg_inbox"), effects: all(host.db, "SELECT * FROM gg_effects"), docs: all(host.db, "SELECT * FROM docs ORDER BY key"), cards: all(host.db, "SELECT * FROM gg_cards") });

// 命令发起前宿主已经静止；只等命令造成的异步唤醒，用有限时间观察。
async function settle(host: Host) { await host.idle(); await new Promise((r) => setTimeout(r, 25)); await host.idle(); }

test("P7 隔离执行:声明的插件命令经过真实子进程并返回系统消息,不投递用户命令", async () => {
  const s = setup(); const g = s.host.createGroup("群", []);
  await install(s, fixture(s, "echo-command", "echo-command", 'return {text: JSON.stringify({pid:process.pid, calls, name:req.name, args:req.args, room:req.roomId, user:req.userId})};'));
  const r = await s.svc.handle("messages.send", send(g.id, "echo-1", "echo-command", { value: "原值" }));
  const m = view(r); assert.equal(m.sender.kind, "system"); const data = JSON.parse(m.text);
  assert.notEqual(data.pid, process.pid);
  assert.deepEqual([data.calls, data.name, data.args, data.room, data.user], [1, "echo-command", { value: "原值" }, g.id, "me"]);
  assert.deepEqual([m.sender.kind, m.command, m.mentions], ["system", null, []]);
  assert.equal(s.host.listMessages(g.id, {}).messages.length, 1);
});

test("P7 只读快照:命令不修改任务卡片草稿和游标,不唤醒联系人", async () => {
  let rounds = 0; const s = setup({ mind: () => scriptedMind({ onRound: () => { rounds++; } }) });
  const c = s.host.createContact({ name: "小克" }); const g = s.host.createGroup("群", [{ kind: "contact", id: c.id }]);
  await install(s, ketchupPath);
  s.host.send({ roomId: g.id, clientActionId: "before", text: "在吗", mentions: [{ id: c.id, source: "manual" }] });
  await settle(s.host);
  const before = state(s.host); const n = rounds;
  const r = await s.svc.handle("messages.send", send(g.id, "read-only", "ketchup"));
  assert.equal(view(r).sender.kind, "system"); await settle(s.host);
  assert.deepEqual(state(s.host), before); assert.equal(rounds, n);
});

test("P7 未读范围:摘要只含已读之后消息,按发言人分组并附来源,重复摘要不汇总自己", async () => {
  const s = setup(); const g = s.host.createGroup("群", []); await install(s, ketchupPath);
  const a = s.host.send({ roomId: g.id, clientActionId: "a", text: "旧消息" });
  const b = s.host.send({ roomId: g.id, clientActionId: "b", text: "新消息第一行\n长文第二行" });
  const r = await s.svc.handle("messages.send", send(g.id, "k1", "ketchup", { from: a.seq }));
  const text = view(r).text;
  assert.ok(text.includes(`新消息 1 条`) && text.includes(`#${b.seq}`) && text.includes("新消息第一行"), text);
  assert.ok(!text.includes("旧消息") && !text.includes("长文第二行"), text);
  const again = await s.svc.handle("messages.send", send(g.id, "k2", "ketchup", { from: a.seq }));
  assert.equal(view(again).text, text);
});

test("P7 空态:默认从真实已读位置起算,没有未读时明确说明", async () => {
  const s = setup(); const g = s.host.createGroup("群", []); await install(s, ketchupPath);
  const m = s.host.send({ roomId: g.id, clientActionId: "read", text: "看过了" });
  const r = await s.svc.handle("messages.send", send(g.id, "empty", "ketchup"));
  assert.equal(view(r).text, `/ketchup · 自 #${m.seq} 之后到 #${m.seq}:没有新消息,没有任务变更,也没有等你拍板的事。`);
});

test("P7 待确认:生产任务交付列入摘要,仍保持待确认状态", async () => {
  const compute = scriptedCompute({ script: () => [{kind:"started",sessionId:"s",resumed:false},{kind:"completed",result:"运行已完成"}] });
  const s = setup({ compute: () => compute.adapter }); await install(s, ketchupPath);
  const c = s.host.createContact({name:"小克"}); const g = s.host.createGroup("群",[{kind:"contact",id:c.id}]);
  s.host.send({roomId:g.id,clientActionId:"task",text:"帮我跑测试",mentions:[{id:c.id,source:"manual"}]});
  for(let i=0;i<100;i++){await settle(s.host);if(compute.drained() && s.host.listTasks({roomId:g.id})[0]?.state === "T5_InReview")break;}
  const t = s.host.listTasks({roomId:g.id})[0]!; assert.equal(t.state,"T5_InReview");
  const seq = s.host.taskDoc(t.id).value.deliveredSeq;
  const r = await s.svc.handle("messages.send",send(g.id,"pending","ketchup",{from:0}));
  const text = view(r).text;
  assert.ok(text.includes(`新建:「${t.title}」(${t.id})`) && text.includes(`交付:「${t.title}」(${t.id})#${seq}`),text);
  assert.ok(text.includes(`待你确认交付:「${t.title}」(${t.id})#${seq}`),text);
  assert.equal(s.host.taskDoc(t.id).value.task.state,"T5_InReview"); compute.close();
});

test("P7 待回答:授权和提问照实列出,摘要不能代答", async () => {
  const compute = scriptedCompute({script:()=>[{kind:"started",sessionId:"s",resumed:false},{kind:"blocked",needs:"要改 app.ts",summary:"准备改"}]}); const s = setup({compute:()=>compute.adapter}); await install(s,ketchupPath); const c=s.host.createContact({name:"小克"}); const g=s.host.createGroup("群",[{kind:"contact",id:c.id}]);
  s.host.updateRoom(g.id,{rules:"改代码前先问我"});
  s.host.send({roomId:g.id,clientActionId:"ask",text:"帮我改 app.ts",mentions:[{id:c.id,source:"manual"}]});
  for(let i=0;i<100;i++){await settle(s.host);if(s.host.listMessages(g.id,{}).messages.some(m=>m.card?.kind==="question"))break;}
  const cards=s.host.listMessages(g.id,{}).messages.filter(m=>m.card?.kind==="question" && m.card.state==="open"); assert.equal(cards.length,1);
  const before=state(s.host); const r=await s.svc.handle("messages.send",send(g.id,"question","ketchup"));
  assert.ok(view(r).text.includes(`等你授权:「${cards[0]!.card!.title}」(${cards[0]!.card!.taskId})#${cards[0]!.seq}`));
  assert.deepEqual(state(s.host),before); compute.close();
});

test("P7 重放:同一 action 并发只执行一次,改参数拒绝,宿主重启仍返回原消息",async()=>{
  const s=setup();const g=s.host.createGroup("群",[]);await install(s,fixture(s,"once","once",'await new Promise(r=>setTimeout(r,20)); return {text:String(calls)};'));
  const p=send(g.id,"same","once");const rs=await Promise.all([s.svc.handle("messages.send",p),s.svc.handle("messages.send",p)]);
  assert.deepEqual(rs.map(r=>[view(r).seq,view(r).text]),[[1,"1"],[1,"1"]]);
  const bad=await s.svc.handle("messages.send",send(g.id,"same","once",{different:true}));assert.equal(!bad.ok && bad.error.code,"conflict");
  await s.host.close();const h=new Host({file:path.join(s.root,"gg.db"),dataDir:path.join(s.root,"data"),mind:()=>scriptedMind()});
  try {const r=await createService(h).handle("messages.send",p);assert.deepEqual([view(r).seq,view(r).text],[1,"1"]);}finally{await h.close();}
});

test("P7 冲突:内置名称与已安装命令名称不得被第二插件占用",async()=>{
  const s=setup();const g=s.host.createGroup("群",[]);
  const builtin=fixture(s,"bad-task","task",'return {text:"bad"};');
  const bad=await s.svc.handle("plugins.install",{clientActionId:"builtin",source:{kind:"local-path",path:builtin},grantedPermissions:["chat:read"]});
  assert.equal(!bad.ok && bad.error.code,"conflict");
  await install(s,fixture(s,"first","shared",'return {text:"first"};'));
  const second=fixture(s,"second","shared",'return {text:"second"};');
  const duplicate=await s.svc.handle("plugins.install",{clientActionId:"second",source:{kind:"local-path",path:second},grantedPermissions:["chat:read"]});assert.equal(!duplicate.ok && duplicate.error.code,"conflict");
  const r=await s.svc.handle("messages.send",send(g.id,"route","shared"));assert.equal(view(r).text,"first");
});

test("P7 停用:命令从列表移除,旧命令调用明确拒绝且不发送给联系人",async()=>{
  const s=setup();const g=s.host.createGroup("群",[]);await install(s,ketchupPath);
  await s.svc.handle("plugins.setEnabled",{pluginId:"ketchup",enabled:false});
  const r=await s.svc.handle("messages.send",send(g.id,"disabled","ketchup"));assert.equal(!r.ok && r.error.code,"conflict");
  const list=await s.svc.handle("commands.list",{roomId:g.id});assert.ok(list.ok && !(list.value as {commands:SlashCommand[]}).commands.some(c=>c.name==="ketchup"));
  assert.equal(s.host.listMessages(g.id,{}).messages.length,0);
});

test("P7 参数和权限:非法范围不落消息,未声明读权限的插件拿不到会话快照",async()=>{
  const s=setup();const g=s.host.createGroup("群",[]);await install(s,ketchupPath);
  const bad=await s.svc.handle("messages.send",send(g.id,"invalid","ketchup",{from:99}));assert.equal(!bad.ok && bad.error.code,"invalid_params");
  await install(s,fixture(s,"no-read","no-read",'return {text:JSON.stringify(req.snapshot)};',false),[]);
  const r=await s.svc.handle("messages.send",send(g.id,"noread","no-read"));assert.equal(view(r).text,"null");
  assert.equal(s.host.listMessages(g.id,{}).messages.length,1);
});

test("P7 失败:插件报错不落假成功消息,同 action 不盲目重跑,新 action 可再试",async()=>{
  const s=setup();const g=s.host.createGroup("群",[]);await install(s,fixture(s,"flaky","flaky",'if(calls===1)throw new Error("fixture failure");return {text:String(calls)};'));
  const p=send(g.id,"failure","flaky");const a=await s.svc.handle("messages.send",p);assert.equal(!a.ok && a.error.code,"unavailable");
  const b=await s.svc.handle("messages.send",p);assert.equal(!b.ok && b.error.code,"unavailable");assert.equal(s.host.listMessages(g.id,{}).messages.length,0);
  const r=await s.svc.handle("messages.send",send(g.id,"retry","flaky"));assert.equal(view(r).text,"2");
});

test("P7 快照可见性:只含本会话可见消息,隐藏和撤回原文以及别群内容不进入插件",async()=>{
  const s=setup();const g=s.host.createGroup("群",[]);const other=s.host.createGroup("别群",[]);await install(s,fixture(s,"snapshot","snapshot",'return {text:JSON.stringify(req.snapshot)};'));
  const a=s.host.send({roomId:g.id,clientActionId:"hide",text:"HIDDEN_NEUTRAL"});const b=s.host.send({roomId:g.id,clientActionId:"retract",text:"RETRACT_NEUTRAL"});
  s.host.send({roomId:other.id,clientActionId:"other",text:"OTHER_ROOM_NEUTRAL"});
  await s.svc.handle("messages.delete",{roomId:g.id,seqs:[a.seq],clientActionId:"delete"});s.host.retractMessage(g.id,b.seq);
  const r=await s.svc.handle("messages.send",send(g.id,"snapshot","snapshot",{from:0}));const text=view(r).text; assert.equal(view(r).sender.kind,"system");
  assert.ok(!text.includes("HIDDEN_NEUTRAL") && !text.includes("RETRACT_NEUTRAL") && !text.includes("OTHER_ROOM_NEUTRAL"),text);
  assert.equal(JSON.parse(text).roomId,g.id);
});


test("P7 内置与未知命令保持原行为,安装插件只接管自己声明的命令",async()=>{
  const s=setup();const c=s.host.createContact({name:"小克"});const g=s.host.createGroup("群",[{kind:"contact",id:c.id}]);await install(s,ketchupPath);
  const task=await s.svc.handle("messages.send",send(g.id,"builtin","task",{contact:c.id,what:"跑测试"}));
  assert.deepEqual(view(task).mentions,[{id:c.id,source:"auto"}]);
  const unknown=await s.svc.handle("messages.send",send(g.id,"unknown","notice"));assert.equal(view(unknown).sender.kind,"user");
  const result=await s.svc.handle("messages.send",send(g.id,"plugin","ketchup"));assert.equal(view(result).sender.kind,"system");
});

test("P7 更新冲突被拒而旧版本可用,停用插件的名称仍保留",async()=>{
  const s=setup();const g=s.host.createGroup("群",[]);
  const first=fixture(s,"owner","owned",'return {text:"owner"};');await install(s,first);await s.svc.handle("plugins.setEnabled",{pluginId:"owner",enabled:false});
  const collision=fixture(s,"collision","owned",'return {text:"collision"};');
  const bad=await s.svc.handle("plugins.install",{clientActionId:"collision",source:{kind:"local-path",path:collision},grantedPermissions:["chat:read"]});assert.equal(!bad.ok&&bad.error.code,"conflict");
  const market=path.join(s.catalog,"rss-reader","plugin.json");
  const old=JSON.parse(readFileSync(market,"utf8"));
  await s.svc.handle("plugins.install",{clientActionId:"rss",source:{kind:"marketplace",id:"rss-reader"},grantedPermissions:["net:fetch"]});
  writeFileSync(market,JSON.stringify({...old,version:"0.2.0",commands:[{name:"stop",description:"bad",args:[]}]}));
  const update=await s.svc.handle("plugins.update",{pluginId:"rss-reader"});assert.equal(!update.ok&&update.error.code,"conflict");
  assert.equal(s.host.plugins.get("rss-reader").version,"0.1.0");
  await s.svc.handle("plugins.setEnabled",{pluginId:"owner",enabled:true});
  const result=await s.svc.handle("messages.send",send(g.id,"reenabled","owned"));assert.equal(view(result).text,"owner");
});

test("P7 非法结果与缺失执行入口显式失败,不能变成用户消息或空成功",async()=>{
  const s=setup();const g=s.host.createGroup("群",[]);await install(s,fixture(s,"invalid-output","invalid-output",'return {text:42};'));
  const invalid=await s.svc.handle("messages.send",send(g.id,"invalid-output","invalid-output"));assert.equal(!invalid.ok&&invalid.error.code,"unavailable");
  const dir=fixture(s,"missing-command","missing-command",'return {text:"x"};');writeFileSync(path.join(dir,"index.mjs"),'export default {kind:"ui-extension"};');await install(s,dir);
  const missing=await s.svc.handle("messages.send",send(g.id,"missing-command","missing-command"));assert.equal(!missing.ok&&missing.error.code,"unavailable");
  assert.equal(s.host.listMessages(g.id,{}).messages.length,0);
});

test("P7 有界展示:超过二百条明确标截断,任务与待办不因消息裁剪丢失",async()=>{
  const s=setup();const g=s.host.createGroup("群",[]);await install(s,ketchupPath);
  for(let i=0;i<205;i++)s.host.send({roomId:g.id,clientActionId:`m${i}`,text:`消息 ${i}`});
  const result=await s.svc.handle("messages.send",send(g.id,"bounded","ketchup",{from:0}));const text=view(result).text;
  assert.ok(text.includes("新消息 205 条（只列最近 200 条）")&&text.includes("#205 消息 204")&&!text.includes("#1 消息 0"),text);
});
