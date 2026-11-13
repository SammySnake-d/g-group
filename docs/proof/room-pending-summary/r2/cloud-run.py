from pathlib import Path
import os,sys,json,subprocess,time,hashlib,re,signal,tarfile
r=Path(__file__).resolve().parent;out=r/'out';out.mkdir(exist_ok=True)
cfg=json.loads((r/'config.json').read_text());repo=r/'repo';head=cfg['head'];rows=[];errors=[];freeze=cfg['frozen_sha256'];deadline=time.monotonic()+3600
(r/'tmp').mkdir(exist_ok=True);env=dict(os.environ,TMPDIR=str(r/'tmp'),npm_config_cache=str(r/'npm-cache'))
def run(name,cmd,cwd=None,want=0,cap=300):
 begin=time.monotonic();timed=False
 with (out/(name+'.log')).open('w') as log:
  p=subprocess.Popen(cmd,cwd=cwd or repo,env=env,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
  try:code=p.wait(timeout=max(1,min(cap,deadline-begin)))
  except subprocess.TimeoutExpired:
   timed=True;os.killpg(p.pid,signal.SIGKILL);code=p.wait()
 raw=(out/(name+'.log')).read_text();row={'name':name,'command':cmd,'exit':code,'expected_exit':want,'timed_out':timed,'seconds':round(time.monotonic()-begin,3),'log_sha256':hashlib.sha256((out/(name+'.log')).read_bytes()).hexdigest()};rows.append(row)
 if code!=want or timed:errors.append(name+': unexpected execution result')
 (out/'status.json').write_text(json.dumps({'head':head,'results':rows,'errors':errors},indent=2)+'\n');print(json.dumps(row),flush=True);return raw
def shape(raw,n):
 assert all(re.search(r'^# '+k+r' '+str(v)+r'$',raw,re.M) for k,v in [('tests',n),('pass',n),('fail',0),('cancelled',0),('skipped',0),('todo',0)])
try:
 assert hashlib.sha256((r/'candidate.bundle').read_bytes()).hexdigest()==cfg['bundle_sha256']
 run('clone',['git','clone','--no-checkout','--no-hardlinks',str(r/'candidate.bundle'),str(repo)],r,cap=60)
 run('checkout',['git','checkout','-B',cfg['branch'],head],cap=60)
 assert subprocess.check_output(['git','rev-parse','HEAD'],cwd=repo,text=True).strip()==head
 assert all((repo/f).is_file() and hashlib.sha256((repo/f).read_bytes()).hexdigest()==s for f,s in freeze.items())
 run('npm-ci',['npm','ci','--no-audit','--no-fund'],cap=300)
 links={p.name:str(p.resolve()) for p in (repo/'node_modules/@g-group').iterdir()}
 assert all(Path(v).is_relative_to(repo/'packages') for v in links.values())
 (out/'freeze.json').write_text(json.dumps({'head':head,'sha256':freeze,'runner_sha256':hashlib.sha256((r/'run.py').read_bytes()).hexdigest(),'config_sha256':hashlib.sha256((r/'config.json').read_bytes()).hexdigest(),'node':subprocess.check_output(['node','--version'],text=True).strip(),'workspace_links':links},indent=2)+'\n')
 narrow=run('narrow-17',['node','--test','--test-concurrency=1','--test-reporter=tap','packages/server/src/room-blocked-summary.test.ts'],cap=120);shape(narrow,17)
 dependency=run('dependency-regression',['node','--test','--test-concurrency=1','--test-reporter=tap',*cfg['dependency_test_files']],cap=240);shape(dependency,30)
 for name,original,cap in zip(['typecheck','lint','full','mutations'],cfg['output_commands'],[240,180,900,1200]):
  cmd=[s.replace('OUT/',str(out)+'/') for s in original]
  raw=run(name,cmd,cap=cap)
  if name=='full':
   if not (re.search(r'^# tests [1-9]\d*$',raw,re.M) and all(re.search(r'^# '+k+r' 0$',raw,re.M) for k in ['fail','cancelled','skipped','todo'])):errors.append('full: incomplete TAP or nonzero failure/skip/cancel/todo')
  if name=='mutations':
   m=json.loads((out/'mutations.json').read_text())
   if not (m['head']==head and m['runner_sha256']==cfg['runner_sha256'] and m['total']==18 and m['killed']==18 and m['source_unchanged'] and all(x['complete'] and x['counts']['tests']==17 and x['killed'] and x['exit']==1 and not x['signal'] and not x['error'] and x['target_test'] in x['assertion_names'] for x in m['results'])):errors.append('mutations: strict named complete execution not satisfied')
except Exception as e:errors.append(repr(e));print('ERROR',repr(e),flush=True)
finally:
 unchanged=bool(freeze) and all((repo/f).is_file() and hashlib.sha256((repo/f).read_bytes()).hexdigest()==h for f,h in freeze.items())
 result={'head':head,'base':cfg['base'],'results':rows,'errors':errors,'source_unchanged':unchanged,'cloud_behavior_complete':not errors and unchanged,'formal_gates_pending':True,'review_pending':True};(out/'result.json').write_text(json.dumps(result,indent=2)+'\n')
 manifest={str(p.relative_to(out)):hashlib.sha256(p.read_bytes()).hexdigest() for p in out.rglob('*') if p.is_file()};(out/'members-sha256.json').write_text(json.dumps(manifest,indent=2)+'\n')
 with tarfile.open(r/'results.tar.gz','w:gz') as t:t.add(out,arcname='out')
 print(json.dumps(result),flush=True);print('archive',hashlib.sha256((r/'results.tar.gz').read_bytes()).hexdigest(),(r/'results.tar.gz').stat().st_size,flush=True)
sys.exit(0 if not errors and unchanged else 1)
