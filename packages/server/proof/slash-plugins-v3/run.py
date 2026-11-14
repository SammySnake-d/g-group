from pathlib import Path
import subprocess,os,sys,json,time,hashlib,re
root=Path('/dev/shm/gg-slash-resume-v3-20261112'); repo=root/'repo'; out=root/'out'; out.mkdir(parents=True,exist_ok=True)
HEAD='29f1fd3c6bc592881b6f39d6cc2a493d50c77080'; RED='e0b539158a8ebc9ee66beb4e065490e531cbcc30'; BASE='c7d1a2dd3671c2a2289a5cd4b3b673a9f1bb9f29'
def call(cmd,cwd=None): return subprocess.run(cmd,cwd=cwd,check=True)
def deps(d):
 mods=d/'node_modules';mods.mkdir(exist_ok=True);(mods/'@g-group').mkdir(exist_ok=True)
 for p in Path('/workspace/cov-base/node_modules').iterdir():
  if p.name=='@g-group':continue
  q=mods/p.name
  if not q.exists(): q.symlink_to(p.resolve())
 for p in (d/'packages').iterdir():
  if p.is_dir() and (p/'package.json').exists():
   q=mods/'@g-group'/p.name
   if not q.exists():q.symlink_to(p)
if not repo.exists():call(['git','clone','--no-hardlinks','--no-checkout','/workspace/cov-base',str(repo)])
call(['git','fetch',str(root/'candidate.bundle'),'HEAD'],repo)
call(['git','checkout','-B','feat/slash-plugins-complete',HEAD],repo)
assert subprocess.check_output(['git','rev-parse','HEAD'],cwd=repo,text=True).strip()==HEAD
deps(repo)
red=root/'red'
if not red.exists():call(['git','worktree','add','--detach',str(red),RED],repo)
deps(red)
tmp=root/'tmp';tmp.mkdir(exist_ok=True);os.environ['TMPDIR']=str(tmp);os.environ['MUT_OUT']=str(out/'mutations')
freeze={}
for name in subprocess.check_output(['git','ls-files','-z'],cwd=repo).decode().split('\0'):
 if name and (repo/name).is_file():freeze[name]=hashlib.sha256((repo/name).read_bytes()).hexdigest()
(out/'source-freeze.json').write_text(json.dumps({'head':HEAD,'base':BASE,'red':subprocess.check_output(['git','rev-parse',RED],cwd=repo,text=True).strip(),'sha256':freeze},indent=2)+'\n')
results=[]
def run(name,cmd,cwd=repo,want=0):
 start=time.time(); log=out/(name+'.log')
 with log.open('w') as f:r=subprocess.run(cmd,cwd=cwd,stdout=f,stderr=subprocess.STDOUT,timeout=450)
 item={'name':name,'command':cmd,'exit_code':r.returncode,'seconds':round(time.time()-start,3),'log_sha256':hashlib.sha256(log.read_bytes()).hexdigest()};results.append(item)
 (out/'status.json').write_text(json.dumps({'head':HEAD,'results':results},indent=2)+'\n')
 print(json.dumps(item),flush=True)
 if r.returncode!=want:raise RuntimeError(f'{name}: exit {r.returncode}, expected {want}')
 return log.read_text()
error=None
try:
 test=['node','--test','--test-concurrency=1','--test-timeout=120000','--test-force-exit','--test-reporter=tap','packages/server/src/slash-commands.test.ts']
 green=run('green',test)
 redout=run('red',test,red,1)
 gp=re.findall(r'^ok \d+ - (.+)$',green,re.M);rf=re.findall(r'^not ok \d+ - (.+)$',redout,re.M)
 assert len(gp)==16 and sorted(gp)==sorted(rf),{'green':gp,'red_failed':rf}
 (out/'red-green.json').write_text(json.dumps({'head':HEAD,'green_pass':gp,'red_fail':rf,'same16':True},ensure_ascii=False,indent=2)+'\n')
 run('mutations',['node','packages/server/proof/slash-plugins-mutations.mjs'])
 run('production',['node','packages/server/proof/slash-plugins-real.ts'])
 run('typecheck',['npm','run','-s','typecheck'])
 run('lint',['npm','run','-s','lint'])
 run('full',['npm','test','--silent'])
except Exception as e:
 error=str(e);print('ERROR',error,flush=True)
finally:
 unchanged=all((repo/p).exists() and hashlib.sha256((repo/p).read_bytes()).hexdigest()==h for p,h in freeze.items())
 result={'head':HEAD,'base':BASE,'results':results,'error':error,'source_unchanged':unchanged,'complete':error is None and len(results)==7}
 (out/'result.json').write_text(json.dumps(result,indent=2)+'\n')
 print(json.dumps(result),flush=True)
sys.exit(0 if error is None else 1)
