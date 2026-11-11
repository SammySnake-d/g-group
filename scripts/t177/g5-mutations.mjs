// G5 逐项定点变异。输入冻结,串行一次一处;只认指定的具名测试按名失败,不认加载/语法失败。原样对照前后各跑一次。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
const KM='packages/kernel/src/memory-marks.ts',KC='packages/kernel/src/memory-capture.ts',KL='packages/kernel/src/run-ledger.ts',SM='packages/server/src/memory-marks.ts',H='packages/server/src/host.ts',A='packages/adapter-pi-contact/src/compact.ts';
const kt='packages/kernel/src/memory-marks.test.ts',st='packages/server/src/memory-marks.test.ts',ht='packages/server/src/memory-two-stage.test.ts',at='packages/adapter-pi-contact/src/memory-refine.test.ts';
const cases=[
 ['G5-K1',KM,'JSON.stringify(["mark", roomId, seq, revision, kind, sha(fold(evidence))])','JSON.stringify(["mark", roomId, seq, kind, sha(fold(evidence))])',kt,'G5-K1 '],
 ['G5-K2',KM,'if (check.source.senderKind !== "user" || m.kind !== "preference" || !isLongTerm(m.evidence ?? "")) return "mark";','if (check.source.senderKind !== "user") return "mark";',kt,'G5-K2 '],
 ['G5-K3',KM,'if (take.length >= policy.maxMarks || bytes + it.bytes > policy.maxBytes) break;','if (bytes + it.bytes > policy.maxBytes) break;',kt,'G5-K3 '],
 ['G5-K4',KM,'if (s.pending >= policy.maxPending) return "backlog";','',kt,'G5-K4 '],
 ['G5-K5',KC,'if (!MARK_KIND_SET.has(String(m.kind))) return { ok: false, reason: "标记 kind 不合法" };','',kt,'G5-K5 '],
 ['G5-K6',KC,'if (d.value.memories.some((m) => m.roomId === undefined || m.sourceSeq === undefined || m.evidence === undefined))','if (false)',kt,'G5-K6 '],
 ['G5-K7',KL,' || unit.timed === true','',kt,'G5-K7 '],
 ['G5-LS4',SM,'if (cur && cur.value.until > now && cur.value.boot === boot && cur.value.holder !== holder) return false;','',st,'G5-LS4 '],
 ['G5-02L',SM,'return this.open(contactId).filter((m) => !m.blocked && (m.retryAt ?? 0) <= now);','return this.open(contactId).filter((m) => (m.retryAt ?? 0) <= now);',st,'G5-02L '],
 ['G5-05S',SM,'if (getDoc(this.db, markKey(m.contactId, m.id))) continue;','',st,'G5-05S '],
 ['G5-01EX',H,'if (direct.some((d) => d.roomId === k.roomId && d.sourceSeq === k.seq && d.evidence === k.evidence)) continue;','',ht,'G5-01EX '],
 ['G5-02RM',H,'if (this.memoryCoverage.dirty(contactId)) return "后台记忆写入待恢复，未接受本次记忆写入";','if (this.memoryCoverage.dirty(contactId) || this.memoryMarks.generation(contactId) === 2) return "后台记忆写入待恢复，未接受本次记忆写入";',ht,'G5-02RM '],
 ['G5-02S4',H,'          valid.push(m);','          valid.push({ ...m, text: `${m.text}(精筛)` });',ht,'G5-02S4 '],
 ['G5-03SW',H,'if (isLanded(check.source.roomId, check.source.seq, m.evidence ?? "", m.text)) continue;','',ht,'G5-03SW '],
 ['G5-04OW',H,'    tx(this.db, () => {\n      this.memoryMarks.addTx(marks);\n','    tx(this.db, () => this.memoryMarks.addTx(marks));\n    tx(this.db, () => {\n',ht,'G5-04OW '],
 ['G5-05TW',KM,'JSON.stringify(["mark", roomId, seq, revision, kind, sha(fold(evidence))])','JSON.stringify(["mark", roomId, seq])',ht,'G5-05TW '],
 ['G5-06ED',H,'if (cur.revision !== m.revision || m.evidence === null || !cur.text.includes(m.evidence)) {','if (false) {',ht,'G5-06ED '],
 ['G5-06RT',SM,'{ state: "disposed", evidence: null, disposition: reason, next, retryAt: null }','{ state: "disposed", disposition: reason, next, retryAt: null }',ht,'G5-06RT '],
 ['G5-07LK',H,'this.setHostTimer(`fine:${contactId}`, at - now, () => this.innerLoop.notify(contactId, "now"));','this.setHostTimer(`fine:${contactId}`, at - now, () => void this.fineScreenTurn(contactId, this.contactDoc(contactId).value, new AbortController().signal));',ht,'G5-07LK '],
 ['G5-07PE',H,'notify: (id, urgency) => { this.fineAborts.get(id)?.(); loop.notify(id, urgency); }','notify: (id, urgency) => { loop.notify(id, urgency); }',ht,'G5-07PE '],
 ['G5-07PG',H,'contactId, upstream: contact.speakingModel, timed: true });','contactId: "_unregistered", upstream: contact.speakingModel, timed: true });',ht,'G5-07PG '],
 ['G5-07ST',H,'    const fine = this.fineStalls.get(u.id);\n    if (fine) {','    const fine = this.fineStalls.get(u.id);\n    if (false) {',ht,'G5-07ST '],
 ['G5-08FL',SM,'      blocked: d.kind !== "retry",\n','      blocked: d.kind !== "retry",\n      ...(d.kind !== "retry" ? { state: "done" as const } : {}),\n',ht,'G5-08FL '],
 ['G5-01IN',SM,'const markKey = (contactId: string, id: string) => `memory-mark:${contactId}:${id}`;','const markKey = (_contactId: string, id: string) => `memory-mark:${id}`;',ht,'G5-01IN '],
 ['G5-03RU',H,'    let done: { effects: HostEffect[] };\n    try {\n      done = this.commitRound(','    this.fineExplicit.add(contactId); await this.fineScreenTurn(contactId, contact, signal);\n    let done: { effects: HostEffect[] };\n    try {\n      done = this.commitRound(',ht,'G5-03RU '],
 ['G5-04BT',H,'createdAt: i.mark.createdAt })), this.finePolicy);','createdAt: i.mark.createdAt })), { ...this.finePolicy, maxMarks: Number.MAX_SAFE_INTEGER });',ht,'G5-04BT '],
 ['G5-04CL',H,'        } else if (signal.aborted || this.closed) {\n','        } else if (signal.aborted || this.closed) {\n          for (const b of batch) this.memoryMarks.done(contactId, b.mark.id, "closed");\n',ht,'G5-04CL '],
 ['G5-02RS',H,'for (const c of this.listContacts()) if (this.memoryMarks.generation(c.id) === 2) this.armFine(c.id);','for (const c of this.listContacts()) for (const m of this.memoryMarks.open(c.id)) this.memoryMarks.dispose(c.id, m.id, "restart", null);',ht,'G5-02RS '],
 ['G5-AD1',A,'    if (speaking !== cfg.model) throw new PiContactMindError("model-mismatch", `联系人的说话模型是 ${speaking},这个压缩器绑定的是 ${cfg.model};精筛只用说话模型,不静默换模`);\n','',at,'G5-AD1 '],
 ['G5-AD2',A,"  \"  粗筛:只有用户本人明确、长期生效的要求或偏好放进 memories 直接记;事实、决定、结果、更正、拿不准的放进 marks:[{\\\"roomId\\\", \\\"seq\\\", \\\"kind\\\": \\\"preference\\\"|\\\"fact\\\"|\\\"decision\\\"|\\\"outcome\\\"|\\\"correction\\\"|\\\"unsure\\\", \\\"evidence\\\": 该条原话}],留给之后的精筛;一条消息里有几件事就给几项,同一项不要两处都放。\",\n",'',at,'G5-AD2 '],
];
const only=process.env.G5_MUT_ONLY?new Set(process.env.G5_MUT_ONLY.split(',')):null;
const out=process.argv[2]??'receipts/evidence/t177-g5/mutations';mkdirSync(out,{recursive:true});
const all=[kt,st,ht,at];
function run(files,name,pattern){const args=['--test','--test-concurrency=1','--test-timeout=30000','--test-force-exit','--test-reporter=tap',...(pattern?[`--test-name-pattern=^${pattern}`]:[]),...files];const r=spawnSync(process.execPath,args,{cwd:process.cwd(),encoding:'utf8',timeout:180000,maxBuffer:32*1024*1024});const log=(r.stdout??'')+(r.stderr??'');writeFileSync(path.join(out,`${name}.tap`),log);return{r,log};}
const control=run(all,'control');if(control.r.status!==0)throw new Error('原样对照不绿,不允许判变异');
const results=[];
for(const[id,file,before,after,testFile,prefix]of cases){if(only&&!only.has(id))continue;const source=readFileSync(file,'utf8');if(source.split(before).length!==2)throw new Error(`${id}: 位置不唯一`);try{writeFileSync(file,source.replace(before,after));const{r,log}=run([testFile],id,prefix);const failed=[...log.matchAll(/^not ok \d+ - (.+)$/gm)].map(m=>m[1]);const killed=r.status!==0&&failed.some(n=>n.startsWith(prefix))&&!/SyntaxError:|ERR_MODULE_NOT_FOUND|ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX|ReferenceError: .* is not defined/.test(log);results.push({id,file,designated:prefix,status:killed?'killed':'survived',exit:r.status,failed});writeFileSync(path.join(out,'results.json'),JSON.stringify({control:{exit:control.r.status},results},null,2)+'\n');console.log(`${id} ${killed?'killed':'survived'}`);}finally{writeFileSync(file,source);}}
const final=run(all,'after-control');console.log(JSON.stringify({mutations:results.length,killed:results.filter(r=>r.status==='killed').length,afterControl:final.r.status}));process.exit(results.every(r=>r.status==='killed')&&final.r.status===0?0:1);
