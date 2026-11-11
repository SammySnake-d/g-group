// G1 宿主入口：真实 SQLite/记忆文件，确定性模型端口；不以 processed_seq 冒充记忆覆盖。
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test, type TestContext } from "node:test";
import { BREAKER_CLOSED, breakerFailure, type CompactMemory, type ReflectRequest, type ReflectResult, type ReflectSource, type RoundInput } from "@g-group/kernel";
import { Host, type HostOptions } from "./host.ts";
import { listDocs, one, putDoc, run } from "./db.ts";
import type { CoverageWork } from "./memory-coverage.ts";
const root = mkdtempSync(path.join(tmpdir(), "gg-memory-reliability-")); let num=0;
after(() => rmSync(root, { recursive: true, force: true }));
const empty = (): ReflectResult => ({ note: null, memories: [], personaSuggestion: null });
const candidate = (s: ReflectSource, over: Partial<CompactMemory> = {}): CompactMemory => ({ title: "语言", text: "用中文回复", anchors: ["global"], relation: null, target: null, kind: "preference", roomId: s.roomId, sourceSeq: s.seq, evidence: s.text, ...over });
function setup(H: typeof Host, t: TestContext, reflect: (r: ReflectRequest) => Promise<ReflectResult>, over: Partial<HostOptions> = {}) {
  const dir=path.join(root,String(++num));mkdirSync(dir);
  const requests: RoundInput[]=[];
  const host=new H({ file:path.join(dir,"db.sqlite"),dataDir:dir,maxDeferMs:2,
    mind:()=>({async round(i){requests.push(i);return{actions:[],stateNote:"MAIN"};}}),
    compactor:()=>({async compact(){return "完整补写笔记";},reflect}),
    retry:{baseDelayMs:1,maxDelayMs:10,jitter:0},...over });
  t.after(()=>host.close());
  const c=host.createContact({name:"查证",speakingModel:"fixture-model"});const dm=host.openDm(c.id);
  return {host,c,dm,dir,requests};
}
async function settle(host: Host) {
  for(let i=0;i<300;i++){await new Promise(r=>setTimeout(r,5));if(!host.loop.busy())return;}
  throw new Error("宿主未收敛");
}
const works=(h:Host)=>listDocs<CoverageWork>(h.db,"memory-coverage:").map(x=>x.value);
test("G1-01H 检查超时不吞欠账 下一轮带旧原文并补查",async t=>{
  let time=0,calls=0;
  const s=setup(Host,t,async r=>{if(++calls===1)throw new Error("upstream 503 timeout");const src=r.sources?.find(x=>x.text==="以后都用中文回复");return src?{...empty(),memories:[candidate(src)]}:empty();},{clockMs:()=>time});
  const first=s.host.send({roomId:s.dm.id,clientActionId:"one",text:"以后都用中文回复"});await settle(s.host);
  assert.ok(one<{processed_seq:number}>(s.host.db,"SELECT processed_seq FROM gg_cursor WHERE contact_id=? AND room_id=?",s.c.id,s.dm.id)!.processed_seq>=first.seq);
  assert.ok(works(s.host).some(w=>w.state==="failed"&&w.sources.some(x=>x.seq===first.seq)),"对话处理完成不等于检查完成");
  time=20;s.host.send({roomId:s.dm.id,clientActionId:"two",text:"再聊一件事"});await settle(s.host);
  assert.match(s.requests[1]!.request.blocks[4]!.text,/以后都用中文回复/);
  assert.ok(works(s.host).some(w=>w.state==="ok"&&w.sources.some(x=>x.seq===first.seq)));
  assert.equal(s.host.listMemories(s.c.id).length,1);
});
test("G1-02H 第一条原话产生的记忆不挂到最后一条用户消息",async t=>{
  let room="",seq=0;
  const s=setup(Host,t,async r=>{assert.equal(r.sources.length,2,"夹具必须同时投递两条消息");return {...empty(),memories:[{title:"语言",text:"用中文回复",anchors:["global"],relation:null,target:null,kind:"preference",roomId:room,sourceSeq:seq,evidence:"以后都用中文回复"}]};});room=s.dm.id;
  const notify=s.host.loop.notify.bind(s.host.loop);s.host.loop.notify=(id)=>notify(id,"batch");
  seq=s.host.send({roomId:room,clientActionId:"one",text:"以后都用中文回复"}).seq;
  s.host.send({roomId:room,clientActionId:"two",text:"现在看看缓存方案"});await settle(s.host);
  const m=s.host.listMemories(s.c.id)[0]!;assert.equal(m.source?.seq,seq);assert.equal(m.source?.userQuote,true);assert.equal(m.source?.quote,"以后都用中文回复");
  assert.deepEqual(m.anchors,["global"]);
});
test("G1-02HYP 宿主不把中文提问的子串写成长期偏好",async t=>{
  let room="",seq=0;
  const s=setup(Host,t,async()=>({...empty(),memories:[{title:"语言",text:"用中文回复",anchors:["global"],relation:null,target:null,kind:"preference",roomId:room,sourceSeq:seq,evidence:"以后都用中文"}]}));room=s.dm.id;
  seq=s.host.send({roomId:room,clientActionId:"one",text:"要不要以后都用中文呢"}).seq;await settle(s.host);
  assert.equal(s.host.listMemories(s.c.id).length,0);assert.ok(works(s.host).some(w=>w.state==="failed"));
});
test("G1-02EDIT 反射在途编辑后改回同字也不接纳旧版本",async t=>{
  let entered!:()=>void,release!:()=>void;const started=new Promise<void>(r=>{entered=r;});const waiting=new Promise<void>(r=>{release=r;});let n=0,room="",seq=0;
  const s=setup(Host,t,async()=>{if(n++>0)return empty();entered();await waiting;return{...empty(),memories:[{title:"语言",text:"用中文回复",anchors:["global"],relation:null,target:null,roomId:room,sourceSeq:seq,evidence:"以后都用中文回复"}]};});room=s.dm.id;
  seq=s.host.send({roomId:room,clientActionId:"one",text:"以后都用中文回复"}).seq;
  await started;try{s.host.editMessage(room,seq,"中间改稿");s.host.editMessage(room,seq,"以后都用中文回复");}finally{release();}
  await settle(s.host);assert.equal(s.host.listMemories(s.c.id).length,0);assert.ok(works(s.host).some(w=>w.disposition!==null));
});
test("G1-02PROJECT 编辑通知使用原消息 seq 和新 revision",async t=>{
  let room="",seq=0;let ready=false;
  const s=setup(Host,t,async()=>ready?{...empty(),memories:[{title:"语言",text:"用中文回复",anchors:["global"],relation:null,target:null,roomId:room,sourceSeq:seq,evidence:"以后都用中文回复"}]}:empty());room=s.dm.id;
  seq=s.host.send({roomId:room,clientActionId:"one",text:"以后都用英文回复"}).seq;await settle(s.host);
  ready=true;s.host.editMessage(room,seq,"以后都用中文回复");await settle(s.host);
  const m=s.host.listMemories(s.c.id)[0]!;assert.equal(m.source?.seq,seq);assert.ok(m.source!.revision!>seq);assert.equal(m.source?.quote,"以后都用中文回复");
});
test("G1-01K 共享熔断打开时后台不发检查请求",async t=>{
  let s!:ReturnType<typeof setup>,calls=0;
  s=setup(Host,t,async()=>empty(),{upstreamOf:()=>"shared",compactor:()=>{
    const b=breakerFailure(BREAKER_CLOSED,{nowMs:0,heal:"A2",member:"contact:other",reason:"401"});assert.ok(b.ok);
    run(s.host.db,"INSERT OR REPLACE INTO gg_breakers (upstream,state,card_id,room_id,updated_at) VALUES (?, ?,NULL,NULL,?)","shared",JSON.stringify(b.state),"now");
    return{async compact(){return"笔记";},async reflect(){calls++;return empty();}};
  }});
  s.host.send({roomId:s.dm.id,clientActionId:"one",text:"以后都用中文回复"});await settle(s.host);
  assert.equal(calls,0);assert.ok(works(s.host).some(w=>w.state!=="ok"));
});
test("G1-03U 不支持 reflect 可补笔记但覆盖不得记成功",async t=>{
  const s=setup(Host,t,async()=>empty(),{mind:()=>({async round(){return{actions:[],stateNote:null};}}),compactor:()=>({async compact(){return"合法补写笔记";}})});
  s.host.send({roomId:s.dm.id,clientActionId:"one",text:"以后都用中文回复"});await settle(s.host);
  assert.equal(s.host.stateNote(s.c.id),"合法补写笔记");assert.ok(works(s.host).some(w=>w.state==="failed"&&/reflect|支持/.test(w.error??"")));
});
test("G1-05T 更正缺 target 给邻域回问一次而不是静默丢弃",async t=>{
  let s!:ReturnType<typeof setup>,old="",changedSeq=0,queries=0;
  s=setup(Host,t,async _r=>{
    if(!changedSeq)return empty();queries++;return{...empty(),memories:[{title:"审查",text:"审查改交 Codex",anchors:[`room:${s.dm.id}`],relation:"change",target:queries===1?null:old,roomId:s.dm.id,sourceSeq:changedSeq,evidence:"审查改交 Codex"}]};
  },{mind:()=>({async round(i){const m=i.fresh.find(x=>x.kind==="message"&&x.sender.kind==="user"&&x.text==="审查交给 Astra");return{actions:m?.kind==="message"?[{kind:"remember" as const,roomId:m.roomId,sourceSeq:m.seq,title:"审查",text:m.text,anchors:[`room:${m.roomId}`],quote:m.text,relation:null,target:null}]:[],stateNote:"MAIN"};}})});
  s.host.send({roomId:s.dm.id,clientActionId:"one",text:"审查交给 Astra"});await settle(s.host);old=s.host.listMemories(s.c.id)[0]!.id;
  changedSeq=s.host.send({roomId:s.dm.id,clientActionId:"two",text:"审查改交 Codex"}).seq;await settle(s.host);
  assert.equal(queries,2);assert.equal(s.host.listMemories(s.c.id).find(x=>x.status==="active")?.body,"审查改交 Codex");
});
test("G1-05C 自动检查的双方用户原话冲突只问用户不替换",async t=>{
  let s!:ReturnType<typeof setup>,old="",changedSeq=0;
  s=setup(Host,t,async()=>changedSeq?{...empty(),memories:[{title:"语言",text:"以后都用英文",anchors:[`room:${s.dm.id}`],relation:"conflict",target:old,roomId:s.dm.id,sourceSeq:changedSeq,evidence:"以后都用英文"}]}:empty(),{mind:()=>({async round(i){const m=i.fresh.find(x=>x.kind==="message"&&x.text==="以后都用中文");return{actions:m?.kind==="message"?[{kind:"remember" as const,roomId:m.roomId,sourceSeq:m.seq,title:"语言",text:m.text,anchors:[`room:${m.roomId}`],quote:m.text,relation:null,target:null}]:[],stateNote:"MAIN"};}})});
  s.host.send({roomId:s.dm.id,clientActionId:"one",text:"以后都用中文"});await settle(s.host);old=s.host.listMemories(s.c.id)[0]!.id;
  changedSeq=s.host.send({roomId:s.dm.id,clientActionId:"two",text:"以后都用英文"}).seq;await settle(s.host);
  assert.deepEqual(s.host.listMemories(s.c.id).map(x=>x.status),["active","active"]);
  const asks=s.host.listMessages(s.dm.id,{}).messages.filter(x=>/记忆冲突/.test(x.text));assert.equal(asks.length,1);assert.ok(asks[0]!.mentions.some(x=>x.id===s.host.userId));
});
test("G1-03F 反射失败 compact 补写成功也保留检查欠账",async t=>{
  const s=setup(Host,t,async()=>{throw new Error("upstream 503");},{mind:()=>({async round(){return{actions:[],stateNote:null};}})});
  putDoc(s.host.db,`note:${s.c.id}`,0,{text:"旧有效笔记"});s.host.send({roomId:s.dm.id,clientActionId:"one",text:"以后都用中文回复"});await settle(s.host);
  assert.equal(s.host.stateNote(s.c.id),"完整补写笔记");assert.ok(works(s.host).some(w=>w.state==="failed"));
});

test("G1-03BAD 畸形检查结果不覆盖旧笔记也不阻塞对话游标", async t => {
  const s=setup(Host,t,async()=>({note:42,memories:[],personaSuggestion:null}) as unknown as ReflectResult,{mind:()=>({async round(){return{actions:[],stateNote:null};}}),compactor:()=>({async compact(){throw new Error("补写也失败");},async reflect(){return {note:42,memories:[],personaSuggestion:null} as unknown as ReflectResult;}})});
  putDoc(s.host.db,`note:${s.c.id}`,0,{text:"旧有效笔记"}); const msg=s.host.send({roomId:s.dm.id,clientActionId:"one",text:"以后都用中文回复"}); await settle(s.host);
  assert.equal(s.host.stateNote(s.c.id),"旧有效笔记");
  assert.ok(one<{processed_seq:number}>(s.host.db,"SELECT processed_seq FROM gg_cursor WHERE contact_id=? AND room_id=?",s.c.id,s.dm.id)!.processed_seq>=msg.seq);
  assert.ok(works(s.host).some(w=>w.state==="failed"));
});
test("G1-01CARD 鉴权修好后点记忆重试同时释放共享熔断探测", async t => {
  let failing=true;
  const s=setup(Host,t,async r=>{if(failing)throw new Error("HTTP 401 unauthorized");const src=r.sources.find(x=>x.text==="以后都用中文回复");return src?{...empty(),memories:[candidate(src)]}:empty();});
  s.host.send({roomId:s.dm.id,clientActionId:"one",text:"以后都用中文回复"});await settle(s.host);
  const card=one<{card_id:string;seq:number}>(s.host.db,"SELECT card_id,seq FROM gg_cards WHERE kind='failure' AND json_extract(meta,'$.kind')='memory-coverage'");assert.ok(card);
  failing=false;s.host.cardAct({roomId:s.dm.id,seq:card.seq,cardId:card.card_id,actionId:"retry-memory",clientActionId:"retry"});await settle(s.host);
  assert.equal(s.host.listMemories(s.c.id).length,1);
  assert.ok(works(s.host).filter(w=>w.sources.some(x=>x.seq===1)).every(w=>w.state==="ok"));
});
test("G1-04HOST 宿主重启先核对已写md 不重问模型不多写", async t => {
  const s=setup(Host,t,async r=>({...empty(),memories:r.sources.filter(x=>x.text==="以后都用中文回复").map(x=>candidate(x))}));
  const memory=Reflect.get(s.host,"memory") as { put:(c:string,e:unknown)=>void };
  const put=memory.put.bind(memory);memory.put=(c,e)=>{put(c,e);throw new Error("after-md-before-index-commit");};
  s.host.send({roomId:s.dm.id,clientActionId:"one",text:"以后都用中文回复"});await settle(s.host);
  assert.ok(works(s.host).some(w=>w.writes!==null&&!w.writesDone));await s.host.close();
  let calls=0;
  const restarted=new Host({file:path.join(s.dir,"db.sqlite"),dataDir:s.dir,maxDeferMs:2,mind:()=>({async round(){return{actions:[],stateNote:null};}}),compactor:()=>({async compact(){return"笔记";},async reflect(){calls++;return empty();}})});t.after(()=>restarted.close());
  assert.equal(restarted.listMemories(s.c.id).length,1);assert.equal(restarted.listMemories(s.c.id)[0]!.version,1);
  assert.ok(works(restarted).every(w=>w.writesDone));assert.equal(calls,0);
});
test("G1-02PRE 对话在途撤回原文 后台检查发送前先核来源", async t => {
  let enter!:()=>void,release!:()=>void;const started=new Promise<void>(r=>{enter=r;});const wait=new Promise<void>(r=>{release=r;});let rounds=0;
  const material:string[]=[];
  const s=setup(Host,t,async r=>{material.push(r.material);return empty();},{mind:()=>({async round(){if(rounds++===0){enter();await wait;}return{actions:[],stateNote:null};}})});
  const m=s.host.send({roomId:s.dm.id,clientActionId:"one",text:"NEUTRAL_ONLY_THIS_WITHDRAWN_SOURCE"});await started;
  try{s.host.retractMessage(s.dm.id,m.seq);}finally{release();}await settle(s.host);
  assert.ok(works(s.host).some(w=>w.disposition!==null));
  assert.equal(material.some(x=>x.includes("NEUTRAL_ONLY_THIS_WITHDRAWN_SOURCE")),false);
});
test("G1-01TIME 后台检查无响应按现有超时阈值留债而不无限阻塞对话", async t => {
  let release!:(r:ReflectResult)=>void;const pending=new Promise<ReflectResult>(r=>{release=r;});
  const s=setup(Host,t,()=>pending,{runThresholds:{defaults:{stallMs:20,firstByteMs:20}}});
  const msg=s.host.send({roomId:s.dm.id,clientActionId:"one",text:"以后都用中文回复"});
  try {
    await new Promise(r=>setTimeout(r,100));
    assert.ok((one<{processed_seq:number}>(s.host.db,"SELECT processed_seq FROM gg_cursor WHERE contact_id=? AND room_id=?",s.c.id,s.dm.id)?.processed_seq??0)>=msg.seq);
    assert.ok(works(s.host).some(w=>w.state==="failed"&&/timeout/.test(w.error??"")));
  } finally {release(empty());await settle(s.host);}
});
