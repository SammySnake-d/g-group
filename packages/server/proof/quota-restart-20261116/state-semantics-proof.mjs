// 只使用 scriptedCompute,不产生/操作 OS 子进程;目标源码通过绝对路径绑定。
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const repo=process.argv[2]; const expected=process.argv[3];
const {Host}=await import(pathToFileURL(path.join(repo,'packages/server/src/host.ts')).href);
const {scriptedCompute,scriptedMind}=await import(pathToFileURL(path.join(repo,'packages/server/src/fakes.ts')).href);
const dir=mkdtempSync(path.join(tmpdir(),'gg-stop-state-proof-'));
const compute=scriptedCompute({script:()=>[{kind:'started',sessionId:'proof-no-process',resumed:false}]});
let first,second;
const until=async(p)=>{const end=Date.now()+3000;while(!p()){if(Date.now()>end)throw Error('测试场景未完成');await new Promise(r=>setTimeout(r,5));}};
try {
 const opts={file:path.join(dir,'host.db'),mind:()=>scriptedMind(),compute:()=>compute.adapter,maxDeferMs:5,personalComputeSlots:1};
 first=new Host({...opts,bootId:'proof-a'});
 const c=first.createContact({name:'状态语义证明'}); const dm=first.openDm(c.id).id;
 first.send({roomId:dm,clientActionId:'proof-one',text:'帮我跑一个很久的任务'});
 await until(()=>first.listTasks({roomId:dm})[0]?.state==='T3_Running');
 const id=first.listTasks({roomId:dm})[0].id;
 const snapshot=(h)=>{const task=h.taskDoc(id).value.task;return {state:task.state,computeId:task.computeId,retired:task.retired,orphans:task.orphans,lease:h.quota.leaseOf(id)??null,waitingFor:h.listTasks({roomId:dm})[0].waitingFor,runs:h.listRuns({}).runs.filter(r=>r.taskId===id).map(r=>({layer:r.layer,status:r.status,note:r.note,text:r.text}))};};
 const before=snapshot(first);
 // 与旧 runs.test 的顺序一致:停止事件源后关闭宿主,没有任何执行器停止确认。
 compute.close(); await first.close(); first=undefined;
 second=new Host({...opts,bootId:'proof-b'}); await second.idle();
 const after=snapshot(second);
 console.log(JSON.stringify({source:repo,before,after},null,2));
 assert.equal(after.state,expected);
 if(expected==='T9_StopRequested'){assert.ok(after.lease);assert.equal(after.computeId,before.computeId);assert.equal(after.retired.length,0);}
 else {assert.equal(after.computeId,null);assert.ok(after.retired.includes(before.computeId));assert.equal(after.lease,null);}
}finally{if(first)await first.close();if(second)await second.close();compute.close();rmSync(dir,{recursive:true,force:true});}
