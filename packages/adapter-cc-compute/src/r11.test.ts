import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createComputeAdapter } from "./adapter.ts";
import { checkSnapshot } from "./brief.ts";
import { checkInit } from "./events.ts";
const dirs: string[] = [];
const fixture = fileURLToPath(new URL("../test-support/round-fixture.mjs", import.meta.url));
const b = {task:"NEUTRAL_FIXTURE_NO_CREDENTIALS",rules:[],tools:[],credentialRefs:[],placement:"local"};
const zero = {constraintVer:0,openQuestions:[],doneSideEffects:[]};
const sleep = (ms: number) => new Promise<void>(r=>setTimeout(r,ms));
async function until(fn:()=>boolean) { const end=Date.now()+5000; while(!fn()) { assert.ok(Date.now()<end,"等待中性夹具超时"); await sleep(20); } }
function setup(mode: string) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"r11-neutral-")); dirs.push(dir);
  const cwd=path.join(dir,"cwd"); fs.mkdirSync(cwd);
  const options={runner:{command:process.execPath,args:[fixture]},hostEnv:{HOME:dir,ROUND_MODE:mode},reapForceMs:150};
  return {options,dir,cwd};
}
const lines=(dir:string)=>fs.readFileSync(path.join(dir,"launches"),"utf8").trim().split("\n").map(l=>JSON.parse(l) as {pid:number;args:string[];resumed:boolean});
const state=(pid:number)=>{try{return execFileSync("ps",["-o","stat=","-p",String(pid)],{encoding:"utf8"}).trim();}catch{return "";}};
const active=(pid:number)=>{const s=state(pid);return s!==""&&!s.startsWith("Z");};
afterEach(async()=>{
  for(const d of dirs) {
    if(fs.existsSync(path.join(d,"launches"))) for(const l of lines(d)) {try{process.kill(-l.pid,"SIGKILL");}catch{ /* 已回收 */ }}
    if(fs.existsSync(path.join(d,"child"))) {try{process.kill(Number(fs.readFileSync(path.join(d,"child"),"utf8")),"SIGKILL");}catch{ /* 已回收 */ }}
    await sleep(20); fs.rmSync(d,{recursive:true,force:true});
  }
  dirs.length=0;
});
// 反例中回收可能故意失效；本测试必须具名失败后继续执行，不拖垮全包 TAP。
async function bounded<T>(p: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([p, new Promise<T>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("中性夹具等待超过 5000ms")), 5000); })]); }
  finally { clearTimeout(timer); }
}
const settled = (a: ReturnType<typeof createComputeAdapter>, id: string) => bounded(a.settled(id));
const resume = (a: ReturnType<typeof createComputeAdapter>, id: string, text: string) => bounded(a.resume(id, text));
async function started(a: ReturnType<typeof createComputeAdapter>, id: string) {
  await bounded((async () => { for await (const e of a.events()) if (e.computeId === id && e.kind === "started") return; })());
}

test("R11-01 快照只在同组后代确已结束后放行",async()=>{
  const {options,dir,cwd}=setup("group-quick"); const a=createComputeAdapter(options); const r=await a.spawn(b,{cwd,handoff:zero}); assert.ok(r.ok);
  await started(a,r.computeId); assert.ok((await a.stop(r.computeId)).ok); await settled(a,r.computeId);
  const child=Number(fs.readFileSync(path.join(dir,"child"),"utf8")); assert.ok(active(child));
  fs.writeFileSync(path.join(dir,"trigger"),""); await until(()=>fs.existsSync(path.join(dir,"marker")));
  assert.equal(fs.readFileSync(path.join(dir,"marker"),"utf8"),"NEUTRAL_FIXTURE_NO_CREDENTIALS");
  assert.deepEqual(a.snapshot(r.computeId),{ok:false,reason:"not-quiescent"});
  process.kill(child,"SIGKILL"); await until(()=>!active(child));
  assert.ok(a.snapshot(r.computeId).ok);
});
test("R11-01 续接等待同组停止确认且组回收后仍可新开一轮",async()=>{
  for(const mode of ["group-quick","group-force"]) {
    const {options,dir,cwd}=setup(mode); const a=createComputeAdapter(options); const r=await a.spawn(b,{cwd,handoff:zero}); assert.ok(r.ok);
    await started(a,r.computeId); await a.stop(r.computeId); await settled(a,r.computeId);
    const child=Number(fs.readFileSync(path.join(dir,"child"),"utf8"));
    if(mode==="group-quick") {
      assert.ok(active(child)); const no=await resume(a,r.computeId,"NEUTRAL_FIXTURE_NO_CREDENTIALS"); assert.equal(no.ok,false);
      assert.equal(lines(dir).length,1); process.kill(child,"SIGKILL");
    }
    await until(()=>!active(child)); assert.ok(a.snapshot(r.computeId).ok);
    assert.ok((await resume(a,r.computeId,"NEUTRAL_FIXTURE_NO_CREDENTIALS")).ok); await settled(a,r.computeId);
    assert.equal(lines(dir).length,2); assert.equal(lines(dir)[1]?.resumed,true);
  }
});
test("R11-02 NUL 续接在受阻轮回收及状态变更之前拒绝，普通续接成功",async()=>{
  const {options,dir,cwd}=setup("blocked"); const a=createComputeAdapter(options); const r=await a.spawn(b,{cwd}); assert.ok(r.ok);
  const before=await settled(a,r.computeId); assert.equal(before.at(-1)?.kind,"blocked"); const pid=lines(dir)[0]!.pid;
  await until(()=>state(pid).startsWith("T"));
  const no=await resume(a,r.computeId,"NEUTRAL\0FIXTURE").catch(e=>({ok:false,thrown:e}));
  assert.ok(active(pid),"非法续接不能先回收旧轮"); assert.equal(state(pid).startsWith("T"),true);
  assert.equal(no.ok,false); assert.equal("thrown" in no,false,"应受控拒绝而非抛错"); assert.deepEqual(await settled(a,r.computeId),before); assert.equal(lines(dir).length,1);
  assert.ok((await resume(a,r.computeId,"NEUTRAL_FIXTURE_NO_CREDENTIALS")).ok); await settled(a,r.computeId); assert.equal(lines(dir).length,2);
});
test("R11-02 CLI 会话号含 NUL 不产出 started 且不能成为续接参数",async()=>{
  for(const mode of ["nul-session","normal"]) {
    const {options,dir,cwd}=setup(mode); const a=createComputeAdapter(options); const r=await a.spawn(b,{cwd}); assert.ok(r.ok); const es=await settled(a,r.computeId);
    if(mode==="nul-session") {assert.equal(es.some(e=>e.kind==="started"),false); assert.equal(es.at(-1)?.kind,"failed"); assert.equal((await resume(a,r.computeId,"NEUTRAL_FIXTURE_NO_CREDENTIALS")).ok,false); assert.equal(lines(dir).length,1);}
    else {assert.equal(es.at(-1)?.kind,"completed"); assert.ok((await resume(a,r.computeId,"NEUTRAL_FIXTURE_NO_CREDENTIALS")).ok); await settled(a,r.computeId); assert.equal(lines(dir).length,2);}
  }
  assert.equal(checkInit({session_id:"neutral\0session",tools:["mcp__host__report_progress"],mcp_servers:[{name:"host",status:"connected"}]}).type,"bad-init");
});
test("R11-02 启动失败受控拒绝并保留旧轮及拒收记录，修复目录后可再续接",async()=>{
  const {options,dir,cwd}=setup("rejected"); const a=createComputeAdapter(options); const r=await a.spawn(b,{cwd,handoff:zero}); assert.ok(r.ok); const before=await settled(a,r.computeId);
  assert.equal(before.at(-1)?.kind,"failed"); const rejects=a.rejectedReports(r.computeId); assert.equal(rejects.length,1);
  const invalid = createComputeAdapter({ runner: { command: process.execPath, args: ["\0"] }, hostEnv: { HOME: dir } });
  const denied = await invalid.spawn(b, { cwd }).catch(e => ({ ok: false, thrown: e }));
  assert.equal(denied.ok, false); assert.equal("thrown" in denied, false);
  fs.rmdirSync(cwd);
  const no=await resume(a,r.computeId,"NEUTRAL_FIXTURE_NO_CREDENTIALS"); assert.equal(no.ok,false);
  assert.deepEqual(await settled(a,r.computeId),before); assert.deepEqual(a.rejectedReports(r.computeId),rejects); assert.equal(lines(dir).length,1);
  assert.ok(a.snapshot(r.computeId).ok); fs.mkdirSync(cwd);
  assert.ok((await resume(a,r.computeId,"NEUTRAL_FIXTURE_NO_CREDENTIALS")).ok); assert.equal((await settled(a,r.computeId)).at(-1)?.kind,"completed");
});
test("R11-03 版本零交接接受且原样装配，不改变负版本拒收",async()=>{
  assert.ok(checkSnapshot(zero).ok); assert.equal(checkSnapshot({...zero,constraintVer:-1}).ok,false);
  const {options,dir,cwd}=setup("normal"); const a=createComputeAdapter(options); const r=await a.spawn(b,{cwd,handoff:zero}); assert.ok(r.ok); await settled(a,r.computeId);
  assert.deepEqual(a.snapshot(r.computeId),{ok:true,snapshot:zero}); assert.ok(lines(dir)[0]?.args.some(x=>x.includes("约束版本: 0")));
});
test("R11-03 无交接时汇报版本零被保存并进入快照",async()=>{
  const {options,cwd}=setup("zero-report"); const a=createComputeAdapter(options); const r=await a.spawn(b,{cwd}); assert.ok(r.ok); await settled(a,r.computeId);
  assert.deepEqual(a.snapshot(r.computeId),{ok:true,snapshot:zero});
});
