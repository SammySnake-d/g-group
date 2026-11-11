// G2-a 的真实回归：用户在原失败卡选择备用模型，同一批后台补写/检查必须一起切换。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Host } from "./host.ts";
async function until(check:()=>boolean):Promise<void>{const end=Date.now()+3000;while(!check()){if(Date.now()>end)throw new Error("等不到具名行为");await new Promise(r=>setTimeout(r,5));}}
test("G2-03 用户选择备用模型重跑 同批对话补写和检查使用同一模型",async t=>{
  const dir=mkdtempSync(path.join(tmpdir(),"gg-speaking-config-"));
  const original="claude-sonnet-4-6",backup="gpt-5";
  const dialogue:string[]=[],factory:string[]=[],checks:string[]=[];let calls=0;
  const host=new Host({file:path.join(dir,"db.sqlite"),dataDir:dir,maxDeferMs:2,retry:{maxAutoRetries:0,unknownMaxRetries:0},
    mind:()=>({async round(i){dialogue.push(i.contact.speakingModel);if(++calls===1)throw new Error("NEUTRAL_UPSTREAM_FAILURE");return{actions:[],stateNote:null};}}),
    compactor:c=>{factory.push(c.speakingModel);return{async compact(r){checks.push(r.contact.speakingModel);return"笔记";},async reflect(r){checks.push(r.contact.speakingModel);return{note:"笔记",memories:[],personaSuggestion:null};}};}
  });
  t.after(async()=>{await host.close();rmSync(dir,{recursive:true,force:true});});
  host.updateSettings({models:[{id:original,label:"原模型",vendor:"anthropic",harnesses:["claude-code"]},{id:backup,label:"备用模型",vendor:"openai",harnesses:["claude-code"]}]});
  const c=host.createContact({name:"查证",speakingModel:original});const dm=host.openDm(c.id);
  host.send({roomId:dm.id,clientActionId:"one",text:"NEUTRAL_FIXTURE_NO_CREDENTIALS"});
  await until(()=>host.listMessages(dm.id,{}).messages.some(m=>m.card?.kind==="failure"));
  const card=host.listMessages(dm.id,{}).messages.find(m=>m.card?.kind==="failure")!;
  host.cardAct({roomId:dm.id,seq:card.seq,cardId:card.card!.cardId,actionId:`switch-model:${backup}`,clientActionId:"switch"});
  await until(()=>checks.length===1);await host.idle();
  assert.deepEqual(dialogue,[original,backup]);
  assert.deepEqual(factory,[backup],"压缩器工厂必须取该轮实际模型，而不是失败的原模型");
  assert.deepEqual(checks,[backup],"检查请求里的联系人模型也必须取该轮快照");
  assert.equal(host.contactDoc(c.id).value.speakingModel,original,"用户只切这批，永久配置不能被改");
});
