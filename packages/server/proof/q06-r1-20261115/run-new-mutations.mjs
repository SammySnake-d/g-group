import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
const root=path.resolve(import.meta.dirname,'../../../..'), out=fs.mkdtempSync(path.join(os.tmpdir(),'gg-q06-r1-mut-'));
console.log(`隔离副本与逐项 TAP: ${out}`);
fs.mkdirSync(out,{recursive:true});
const tests=['packages/kernel/src/attention-exclusive-r1.test.ts','packages/server/src/trend-summary-r1.test.ts'];
const S='packages/server/src/trend-summaries.ts', A='packages/kernel/src/attention.ts';
const cases=[
 ['privacy-parser',S,'if (error.startsWith("有要点没带来源")) return "有要点没带来源";','if (error.startsWith("有要点没带来源")) return error;', 'R1-01 解析失败含来源原文后撤回'],
 ['privacy-legacy',S,'error: safeError(r.error),','error: r.error,','R1-01 旧版遗留错误在本端隐藏后'],
 ['privacy-scrub',S,'run(this.d.db, "UPDATE gg_summaries SET error = NULL, items = \'[]\' WHERE id = ?", row.id);','run(this.d.db, "UPDATE gg_summaries SET items = \'[]\' WHERE id = ?", row.id);','R1-01 旧版遗留失败错误在撤回时'],
 ['pagination-contact',S,'s.contact_id > ?', 's.contact_id < ?', 'R1-02 同终点不同联系人'],
 ['pagination-version',S,'s.version < ?', 's.version > ?', 'R1-02 同终点历史多版本'],
 ['pagination-id',S,'s.id > ?', 's.id < ?', 'R1-02 同联系人同版本同终点'],
 ['snapshot-time',S,'set.status === "failed" ? null : this.d.now(),','set.status === "failed" ? null : "2000-01-01T00:00:00.000Z",','R1-04 摘要记生成完成时点'],
 ['snapshot-model',S,'model: JSON.parse(r.model) as { speakingModel: string },','model: { speakingModel: this.d.contact(r.contact_id)?.profile.speakingModel ?? "" },','R1-04 摘要记生成完成时点'],
];
const copy=name=>{
 const d=path.join(out,name);fs.mkdirSync(d,{recursive:true});
 fs.cpSync(path.join(root,'packages'),path.join(d,'packages'),{recursive:true,filter:p=>!p.includes(`${path.sep}proof`)&&!p.includes(`${path.sep}node_modules`)});
 for(const f of ['package.json','tsconfig.json'])fs.copyFileSync(path.join(root,f),path.join(d,f));
 fs.mkdirSync(path.join(d,'node_modules','@g-group'),{recursive:true});
 for(const x of fs.readdirSync(path.join(root,'node_modules'))){if(x==='@g-group'||x==='.bin'||x.startsWith('.'))continue;fs.symlinkSync(path.join(root,'node_modules',x),path.join(d,'node_modules',x));}
 for(const x of fs.readdirSync(path.join(root,'packages')))fs.symlinkSync(path.join('..','..','packages',x),path.join(d,'node_modules','@g-group',x));
 return d;
};
const run=(d,tag)=>{const r=spawnSync(process.execPath,['--test','--test-reporter=tap','--test-concurrency=1','--test-timeout=30000','--test-force-exit',...tests],{cwd:d,encoding:'utf8',timeout:60000,maxBuffer:8e6}); const data=(r.stdout||'')+(r.stderr||'');fs.writeFileSync(path.join(out,`${tag}.tap`),data);return {status:r.status,signal:r.signal,error:r.error?.message,passed:[...data.matchAll(/^ok \d+ - (.+)$/gm)].map(x=>x[1]),failed:[...data.matchAll(/^not ok \d+ - (.+)$/gm)].map(x=>x[1]),tests:Number(/^# tests (\d+)$/m.exec(data)?.[1]),cancelled:Number(/^# cancelled (\d+)$/m.exec(data)?.[1]),skipped:Number(/^# skipped (\d+)$/m.exec(data)?.[1]),todo:Number(/^# todo (\d+)$/m.exec(data)?.[1])};};
const base=run(copy('clean'),'clean');console.log('clean',JSON.stringify(base));let ok=base.status===0&&base.tests>0&&base.cancelled===0&&base.skipped===0&&base.todo===0;
for(const [name,file,from,to,expect] of cases){
 const d=copy(name),f=path.join(d,file),src=fs.readFileSync(f,'utf8'),n=src.split(from).length-1;if(n!==1){ok=false;console.log(name,`INJECTION_ERROR ${n}`);continue;}
 fs.writeFileSync(f,src.replace(from,to));const r=run(d,name);let hit=r.failed.some(t=>t.startsWith(expect));let valid=r.status===1&&r.tests===base.tests&&r.cancelled===0&&r.skipped===0&&r.todo===0&&hit;if(!valid)ok=false;console.log(name,JSON.stringify({valid,...r}));
}
process.exit(ok?0:1);
