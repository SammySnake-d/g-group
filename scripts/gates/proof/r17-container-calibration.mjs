// 真实 Docker 夹具的定点标定。每个故障复制整份门禁,不修改运行中的源码。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
const root = path.resolve(import.meta.dirname, '../../..');
const evidence = process.env.R17_GATE_LOG_DIR;
if (!evidence || !process.env.GATE_SANDBOX_IMAGE) throw new Error('需要证据目录和实际 Docker 镜像');
fs.mkdirSync(evidence, {recursive:true});
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'r17-container-calibration-'));
const matrix = [
 ['workspace', 'lib.ts', 'fs.symlinkSync(dest, to);', 'void dest; fs.symlinkSync(target, to);', 'R15-03'],
 ['readonly', 'lib.ts', '`${m}:${m}:ro`', '`${m}:${m}`', 'R15-04'],
 ['baseline-load', 'gates.ts', 'for (const t of baseline.failed) out.push(', 'for (const t of [] as NamedTest[]) out.push(', 'R15-05 一份'],
 ['baseline-missing', 'gates.ts', 'for (const k of want) if (!base.has(k))', 'for (const k of want) if (false && !base.has(k))', 'R15-05 运行时'],
 ['linked-copy', 'lib.ts', 'if (!fs.lstatSync(from).isFile() || !(resolved === root || resolved.startsWith(`${root}${path.sep}`)))', 'if (false)', 'R17-04 跟踪'],
];
function run(dir, pattern, tag) {
 const script=`import {selfTest} from ${JSON.stringify(new URL('file://'+path.join(dir,'scripts/gates/selftest.ts')).href)}; process.exitCode=selfTest(c=>new RegExp(${JSON.stringify(pattern)}).test(c.name))?0:1;`;
 const r=spawnSync(process.execPath,['--input-type=module','-e',script],{cwd:dir,env:process.env,encoding:'utf8',timeout:600000,maxBuffer:20*1024*1024});
 const out=(r.stdout??'')+(r.stderr??'');
 fs.writeFileSync(path.join(evidence,tag+'.log'),out+`\nEXIT=${r.status} ERROR=${r.error?.message??''}\n`);
 return {status:r.status,out,error:r.error};
}
let killed=0;
try {
 const clean=run(root,'^(R15-0[345]|R17-04)','clean');
 console.log(`原样 Docker 夹具:${clean.status===0?'通过':'失败'}`);
 if(clean.status!==0) throw new Error('原样夹具失败,不得解释变异');
 for(const [id,file,from,to,target] of matrix) {
  const dir=path.join(tmp,id);fs.mkdirSync(path.join(dir,'scripts/gates'),{recursive:true});
  for(const name of fs.readdirSync(path.join(root,'scripts/gates'))) if(/\.(ts|json)$/.test(name)) fs.copyFileSync(path.join(root,'scripts/gates',name),path.join(dir,'scripts/gates',name));
  fs.symlinkSync(path.join(root,'node_modules'),path.join(dir,'node_modules'));
  fs.writeFileSync(path.join(dir,'package.json'),' {"type":"module"}');
  const f=path.join(dir,'scripts/gates',file),s=fs.readFileSync(f,'utf8');
  if(s.split(from).length!==2) throw new Error(`${id}:注入点不唯一`);
  fs.writeFileSync(f,s.replace(from,to));
  const r=run(dir,'^'+target,id);
  const found=r.status===1&&!r.error&&r.out.split('\n').some(l=>l.startsWith('✗ ')&&l.includes(target))&&!r.out.includes('没有可用沙箱');
  if(found)killed++;
  console.log(`${found?'✓':'✗'} ${id}:指定夹具「${target}」${found?'发现故障':'未完成标定'}`);
 }
 console.log(`容器定点变异 ${matrix.length}:杀死 ${killed},存活 ${matrix.length-killed}`);
 process.exitCode=killed===matrix.length?0:1;
} finally {fs.rmSync(tmp,{recursive:true,force:true});}
