from pathlib import Path
import os,sys,json,subprocess,time,hashlib,re,signal,tarfile,shutil
r=Path('/workspace/req-retract-disclosure-20261113');out=r/'out';out.mkdir(exist_ok=True)
cfg=json.loads((r/'config.json').read_text());repo=r/'repo';red=r/'red';head=cfg['head'];base=cfg['base'];rows=[];errors=[];freeze={};deadline=time.monotonic()+3600
(r/'tmp').mkdir(exist_ok=True);env=dict(os.environ,TMPDIR=str(r/'tmp'),npm_config_cache=str(r/'npm-cache'))
def run(name,cmd,cwd=repo,want=0,cap=300,extra=None):
 begin=time.monotonic();e=dict(env);e.update(extra or {});timed=False
 with (out/(name+'.log')).open('w') as log:
  p=subprocess.Popen(cmd,cwd=cwd,env=e,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
  try:code=p.wait(timeout=max(1,min(cap,deadline-begin)))
  except subprocess.TimeoutExpired:
   timed=True;os.killpg(p.pid,signal.SIGKILL);code=p.wait()
 raw=(out/(name+'.log')).read_text();row={'name':name,'command':cmd,'exit':code,'expected_exit':want,'timed_out':timed,'seconds':round(time.monotonic()-begin,3),'log_sha256':hashlib.sha256((out/(name+'.log')).read_bytes()).hexdigest()};rows.append(row)
 if code!=want or timed:errors.append(name+': unexpected execution result')
 (out/'status.json').write_text(json.dumps({'head':head,'results':rows,'errors':errors},indent=2)+'\n');print(json.dumps(row),flush=True);return raw
try:
 assert hashlib.sha256((r/'candidate.bundle').read_bytes()).hexdigest()==cfg['bundle_sha256']
 run('clone',['git','clone','--no-checkout','--no-hardlinks',str(r/'candidate.bundle'),str(repo)],r,cap=60)
 run('checkout',['git','checkout','-B','feat/retract-side-effect-disclosure',head],cap=60)
 run('red-worktree',['git','worktree','add','--detach',str(red),cfg['red']],cap=60)
 run('npm-green',['npm','ci','--no-audit','--no-fund'],cap=180)
 run('npm-red',['npm','ci','--no-audit','--no-fund'],red,cap=180)
 for f in subprocess.check_output(['git','ls-files','-z'],cwd=repo).decode().split('\0'):
  if f and (repo/f).is_file():freeze[f]=hashlib.sha256((repo/f).read_bytes()).hexdigest()
 for f in cfg['test_files']:assert hashlib.sha256((red/f).read_bytes()).hexdigest()==freeze[f]
 (out/'freeze.json').write_text(json.dumps({'head':head,'red':cfg['red'],'base':base,'sha256':freeze,'runner_sha256':hashlib.sha256((r/'run.py').read_bytes()).hexdigest(),'node':subprocess.check_output(['node','--version'],text=True).strip()},indent=2)+'\n')
 tests=['node','--test','--test-concurrency=1','--test-reporter=tap',*cfg['test_files']]
 def shape(raw,passes,failures):
  assert f'# tests {passes+failures}\n' in raw and f'# pass {passes}\n' in raw and f'# fail {failures}\n' in raw
  assert all(f'# {k} 0\n' in raw for k in ['cancelled','skipped','todo'])
 rr=run('same-eight-red',tests,red,want=1,cap=60);shape(rr,4,4)
 failed=re.findall(r'^not ok \d+ - (.+)$',rr,re.M);assert all(any(n.startswith(p) for n in failed) for p in ['RC03 ','RD01 ','RD03 ','RD04 ']);assert len(re.findall(r'^\s+code: [\'\"]ERR_ASSERTION[\'\"]\s*$',rr,re.M))==4
 gg=run('same-eight-green',tests,cap=60);shape(gg,8,0)
 run('mutations',['node','packages/server/proof/retract-disclosure-mutations.mjs'],cap=300,extra={'MUT_OUT':str(out/'mutations')})
 mutations=json.loads((out/'mutations/mutations.json').read_text());assert mutations['summary']=={'total':12,'killed':12,'survived':0};assert all(x.get('complete') and x['killed'] and not x['timedOut'] for x in mutations['rows'])
 run('dependency-regression',['node','--test','--test-concurrency=1','--test-reporter=tap','packages/server/src/memory-hygiene.test.ts','packages/server/src/chat-admin.test.ts'],cap=180)
 run('typecheck',['npm','run','-s','typecheck'],cap=180)
 run('lint',['npm','run','-s','lint'],cap=120)
 run('full',['npm','test','--silent'],cap=900)
 docker=shutil.which('docker');assert docker,'docker binary not installed'
 image='node:22.22.0-slim';imagecheck=subprocess.run(['sudo','-n',docker,'image','inspect',image],capture_output=True,text=True)
 (out/'official-image-inspect.log').write_text(imagecheck.stdout+imagecheck.stderr)
 if imagecheck.returncode:run('official-image-pull',['sudo','-n',docker,'pull',image],cap=600)
 shim=r/'bin';shim.mkdir(exist_ok=True);sh=shim/'docker';sh.write_text('#!/bin/sh\nexec sudo -n '+docker+' "$@"\n');sh.chmod(0o755)
 gates=run('mechanical-gates',['node','scripts/gates/run-all.ts','--local','--branch=feat/retract-side-effect-disclosure','--base='+base],want=1,cap=1200,extra={'PATH':str(shim)+':'+env['PATH'],'GATE_SANDBOX_IMAGE':image})
 decisions={m.group(2):m.group(1)=='✓' for m in re.finditer(r'^([✓✗])\s+(G-[A-Z-]+)\s',gates,re.M)}
 (out/'gate-decisions.json').write_text(json.dumps({'decisions':decisions,'review_null_provenance_not_substantive':True},indent=2)+'\n')
 for gate in ['G-TRACE','G-RED','G-STUB','G-TAUTO','G-WORKFLOW','G-LAYER']:
  if decisions.get(gate) is not True:errors.append(gate+': mechanical gate did not pass; no assertion weakening or waiver')
except Exception as e:errors.append(repr(e));print('ERROR',repr(e),flush=True)
finally:
 unchanged=bool(freeze) and all((repo/f).is_file() and hashlib.sha256((repo/f).read_bytes()).hexdigest()==h for f,h in freeze.items())
 result={'head':head,'red':cfg['red'],'base':base,'results':rows,'errors':errors,'source_unchanged':unchanged,'complete':not errors and unchanged,'review_pending':True};(out/'result.json').write_text(json.dumps(result,indent=2)+'\n')
 with tarfile.open(r/'results.tar.gz','w:gz') as t:t.add(out,arcname='out')
 print(json.dumps(result),flush=True);print('archive',hashlib.sha256((r/'results.tar.gz').read_bytes()).hexdigest(),(r/'results.tar.gz').stat().st_size,flush=True)
sys.exit(0 if not errors else 1)
