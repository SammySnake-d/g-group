// R11 独立中性夹具：不读取账户、不起真实 CLI；所有数据只写入指定假 HOME。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
const home = process.env.HOME;
const mode = process.env.ROUND_MODE;
const args = process.argv.slice(2);
const resumed = args.includes('--resume');
const out = x => process.stdout.write(JSON.stringify(x) + '\n');
const report = (input, id) => {
  out({ type:'assistant', message:{content:[{type:'tool_use',name:'mcp__host__report_progress',id,input}]}});
  out({ type:'user', message:{content:[{type:'tool_result',tool_use_id:id,content:'NEUTRAL_FIXTURE_NO_CREDENTIALS'}]}});
};
fs.appendFileSync(path.join(home,'launches'), JSON.stringify({pid:process.pid,args,resumed})+'\n');
if (!resumed && (mode === 'group-quick' || mode === 'group-force')) {
  const c = spawn(process.execPath,['-e',`const fs=require('node:fs'); const p=${JSON.stringify(home)};
process.on('SIGTERM',()=>{}); process.send('ready');
setInterval(()=>{ if(fs.existsSync(p+'/trigger')) fs.writeFileSync(p+'/marker','NEUTRAL_FIXTURE_NO_CREDENTIALS'); },10);`],{stdio:['ignore','ignore','ignore','ipc']});
  await new Promise(r => c.once('message',r));
  fs.writeFileSync(path.join(home,'child'),String(c.pid));
  c.disconnect(); c.unref();
  process.on('SIGTERM',()=>{ fs.writeFileSync(path.join(home,'term'),'NEUTRAL_FIXTURE_NO_CREDENTIALS'); if(mode==='group-quick') process.exit(0); });
}
const sid = mode === 'nul-session' ? 'neutral\0session' : 'neutral-session';
out({type:'system',subtype:'init',session_id:sid,tools:['mcp__host__report_progress'],mcp_servers:[{name:'host',status:'connected'}]});
if (!resumed && mode === 'blocked') report({kind:'blocked',summary:'NEUTRAL_FIXTURE_NO_CREDENTIALS',needs:'NEUTRAL_FIXTURE_NO_CREDENTIALS',constraintVer:0},'b');
if (!resumed && mode === 'rejected') report({kind:'blocked',summary:'NEUTRAL_FIXTURE_NO_CREDENTIALS'},'bad');
if (mode === 'zero-report') report({kind:'milestone',stage:'NEUTRAL_FIXTURE_NO_CREDENTIALS',summary:'NEUTRAL_FIXTURE_NO_CREDENTIALS',constraintVer:0},'zero');
if (!resumed && ['blocked','group-quick','group-force'].includes(mode)) setInterval(()=>{},1000);
else {out({type:'result',subtype:'success',is_error:false,result:'NEUTRAL_FIXTURE_NO_CREDENTIALS'});}
