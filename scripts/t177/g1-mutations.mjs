// G1 逐项变异。输入冻结，串行一次一处；只认指定测试按名失败，不认加载失败。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
const K='packages/kernel/src/memory-capture.ts',C='packages/server/src/memory-coverage.ts',H='packages/server/src/host.ts',A='packages/adapter-pi-contact/src/compact.ts';
const kt='packages/kernel/src/memory-capture.test.ts',ct='packages/server/src/memory-coverage.test.ts',ht='packages/server/src/memory-reliability.test.ts',at='packages/adapter-pi-contact/src/memory-completion.test.ts';
const cases=[
 ['G1-01TIME',H,'Promise.race([Promise.resolve().then(()=>call(ac.signal)),stopped,expired])','Promise.race([Promise.resolve().then(()=>call(ac.signal)),stopped])',ht,'G1-01TIME '],
 ['G1-02PRE',H,'if(!beforeCall.valid){this.disposeCoverage(work,beforeCall.sources);return null;}','if(false){this.disposeCoverage(work,beforeCall.sources);return null;}',ht,'G1-02PRE '],
 ['G1-03a',A,'|| msg.stopReason === "length"','|| (msg.stopReason === "length" && sys !== SYSTEM)',at,'G1-03a '],
 ['G1-03b',A,'|| msg.stopReason === "length"','|| (msg.stopReason === "length" && sys === SYSTEM)',at,'G1-03b '],
 ['G1-01V',K,'Math.max(rev, e.seq)','seq',kt,'G1-01V '],
 ['G1-02H',K,'&& !CHINESE_HYPOTHETICAL.test(sentence)','',kt,'G1-02H '],
 ['G1-02Q',K,'&& !CHINESE_QUESTION.test(sentence)','',kt,'G1-02Q '],
 ['G1-02E',K,'&& !HYPOTHETICAL.test(sentence)','',kt,'G1-02E '],
 ['G1-02R',K,'s.roomId === candidate.roomId && s.seq === candidate.sourceSeq','s.seq === candidate.sourceSeq',kt,'G1-02R '],
 ['G1-02M',K,'return no("缺少逐条 roomId/sourceSeq/evidence");','return { ok: true, source: current[0]!, anchors: candidate.anchors };',kt,'G1-02M '],
 ['G1-02V',K,'visible.revision !== src.revision || ','',kt,'G1-02V '],
 ['G1-02S',K,'src.senderKind === "user" && LONG_TERM.test(candidate.evidence)','src.senderKind === "user"',kt,'G1-02S '],
 ['G1-02A',K,'if (candidate.anchors.some(a => a.startsWith("user:") && a !== `user:${src.senderId}`))','if (false)',kt,'G1-02A '],
 ['G1-02C',K,'!directPassage(src.text, candidate.evidence)','false',kt,'G1-02C '],
 ['G1-03D',K,'if (r.note !== null && !str(r.note))','if (false)',kt,'G1-03D '],
 ['G1-01B',C,'const refs = [...sources].sort((a,b) => a.roomId.localeCompare(b.roomId) || a.seq-b.seq || a.revision-b.revision);','const refs = [...sources];',ct,'G1-01B '],
 ['G1-01R',C,'now+decision.delayMs','now',ct,'G1-01R '],
 ['G1-01A',C,'decideRetry({heal,effect:"B0",attempts:w.attempts},policy,rand)','decideRetry({heal:"A1",effect:"B0",attempts:w.attempts},policy,rand)',ct,'G1-01A '],
 ['G1-03Z',C,'state:work.unresolved ? "failed":"ok"','state:"failed"',ct,'G1-03Z '],
 ['G1-04N',C,'if(disk?.captureIds?.includes(write.id)) { this.memory.put(work.contactId,disk);continue; }','if(false) { this.memory.put(work.contactId,disk!);continue; }',ct,'G1-04N '],
 ['G1-04E',C,'this.memory.put(work.contactId,disk);continue;','this.memory.put(work.contactId,{...disk,version:disk.version+1,evidence:[...disk.evidence,...disk.evidence]});continue;',ct,'G1-04E '],
 ['G1-04C',C,'for(const [i,entry] of write.after.entries())','for(const [i,entry] of write.after.slice(0,1).entries())',ct,'G1-04C '],
 ['G1-04I',C,'else this.memory.remove(work.contactId,entry.id);','else void entry;',ct,'G1-04I '],
 ['G1-04T',C,'for(const write of work.writes!)','for(const write of work.writes!.slice(0,1))',ct,'G1-04T '],
 ['G1-03P',C,'state:work.unresolved ? "failed":"ok"','state:"ok"',ct,'G1-03P '],
 ['G1-01H',H,'.filter(w=>w.id!==coverage.id).slice(0,1)','.filter(w=>w.id!==coverage.id).slice(0,0)',ht,'G1-01H '],
 ['G1-02H-host',H,'seq:valid.source.seq,userQuote:valid.source.senderKind===','seq:current.at(-1)!.seq,userQuote:valid.source.senderKind===',ht,'G1-02H '],
 ['G1-02HYP',K,'&& !CHINESE_QUESTION.test(sentence)','',ht,'G1-02HYP '],
 ['G1-02EDIT',K,'Math.max(rev, e.seq)','seq',ht,'G1-02EDIT '],
 ['G1-02PROJECT',H,'event && event.body.kind!=="message"?event.body.target:f.seq','f.seq',ht,'G1-02PROJECT '],
 ['G1-01K',H,'if(!this.admitUpstream(work.upstream,"background"))','if(false)',ht,'G1-01K '],
 ['G1-03U',H,'if(!compactor.reflect){this.failCoverage(work,new Error("适配器不支持 reflect，未执行记忆检查"),"A3");return null;}','if(!compactor.reflect){this.memoryCoverage.prepare(work.id,[],0);this.memoryCoverage.apply(work.id);return null;}',ht,'G1-03U '],
 ['G1-05T',H,'if(result.memories.some(m=>m.relation&&m.target===null))','if(false)',ht,'G1-05T '],
 ['G1-05C',H,'userQuote:valid.source.senderKind==="user"','userQuote:false',ht,'G1-05C '],
 ['G1-03F',H,'if (note === null && !reflected && compactor && fresh.length > 0 && !this.memoryCoverage.get(coverage.id).disposition)','if (false && note === null && !reflected && compactor && fresh.length > 0)',ht,'G1-03F '],
 ['G1-03BAD',K,'if (r.note !== null && !str(r.note))','if (false)',ht,'G1-03BAD '],
 ['G1-01CARD',H,'this.manualProbe.add(this.memoryCoverage.get(memory.coverageId).upstream);','',ht,'G1-01CARD '],
 ['G1-04HOST',H,'this.recoverMemoryWrites();','// 未恢复持久写入',ht,'G1-04HOST '],
];
const out=process.argv[2]??'receipts/evidence/t177-g1/mutations';mkdirSync(out,{recursive:true});
function run(files,name,pattern){const args=['--test','--test-concurrency=1','--test-timeout=20000','--test-reporter=tap',...(pattern?[`--test-name-pattern=^${pattern}`]:[]),...files];const r=spawnSync(process.execPath,args,{cwd:process.cwd(),encoding:'utf8',timeout:120000,maxBuffer:32*1024*1024});const log=(r.stdout??'')+(r.stderr??'');writeFileSync(path.join(out,`${name}.tap`),log);return{r,log};}
const control=run([at,kt,ct,ht],'control');if(control.r.status!==0)throw new Error('原样对照不绿，不允许判变异');
const results=[];
for(const[id,file,before,after,testFile,prefix]of cases){const source=readFileSync(file,'utf8');if(source.split(before).length!==2)throw new Error(`${id}: 位置不唯一`);try{writeFileSync(file,source.replace(before,after));const{r,log}=run([testFile],id,prefix);const failed=[...log.matchAll(/^not ok \d+ - (.+)$/gm)].map(m=>m[1]);const killed=r.status!==0&&failed.some(n=>n.startsWith(prefix))&&!/SyntaxError:|ERR_MODULE_NOT_FOUND|ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX/.test(log);results.push({id,file,designated:prefix,status:killed?'killed':'survived',exit:r.status,failed});writeFileSync(path.join(out,'results.json'),JSON.stringify({control:{exit:control.r.status},results},null,2)+'\n');console.log(`${id} ${killed?'killed':'survived'}`);}finally{writeFileSync(file,source);}}
const final=run([at,kt,ct,ht],'after-control');console.log(JSON.stringify({mutations:results.length,killed:results.filter(r=>r.status==='killed').length,afterControl:final.r.status}));process.exit(results.every(r=>r.status==='killed')&&final.r.status===0?0:1);
