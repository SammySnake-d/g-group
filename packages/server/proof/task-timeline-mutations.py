from pathlib import Path
import os,sys,subprocess,json,tempfile,hashlib,tarfile,io,re,time,shutil,signal
source=Path(__file__).resolve().parents[3]
plan=json.loads((source/'packages/server/proof/task-timeline-mutations-plan.json').read_text())
out=Path(os.environ.get('MUT_OUT',str(source/'packages/server/proof/task-timeline-mutation-output')));out.mkdir(parents=True,exist_ok=True)
head=subprocess.check_output(['git','rev-parse','HEAD'],cwd=source,text=True).strip()
files=[f for f in subprocess.check_output(['git','ls-files','-z'],cwd=source).decode().split('\0') if f and (source/f).is_file()]
seal={f:hashlib.sha256((source/f).read_bytes()).hexdigest() for f in files}
tmp=Path(tempfile.mkdtemp(prefix='task-timeline-mutants-',dir=os.environ.get('TMPDIR')))
rows=[]
def execute(label):
 start=time.monotonic();timed=False
 with (out/(label+'.tap')).open('w') as log:
  p=subprocess.Popen(['node','--test','--test-concurrency=1','--test-reporter=tap',plan['test_file']],cwd=tmp,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
  try: code=p.wait(timeout=90)
  except subprocess.TimeoutExpired: timed=True;os.killpg(p.pid,signal.SIGKILL);code=p.wait()
 raw=(out/(label+'.tap')).read_text()
 counts={k:int(re.search(r'^# '+k+r' (\d+)$',raw,re.M).group(1)) if re.search(r'^# '+k+r' (\d+)$',raw,re.M) else None for k in ['tests','pass','fail','cancelled','skipped','todo']}
 failed=[{'name':m.group(1),'assertion':bool(re.search(r"code: ['\"]ERR_ASSERTION['\"]",m.group(2)))} for m in re.finditer(r'^not ok \d+ - (.+)\n([\s\S]*?)(?=^# Subtest:|^1\.\.|\Z)',raw,re.M)]
 complete=counts['tests']==plan['expected_total_tests'] and all(counts[k]==0 for k in ['cancelled','skipped','todo']) and not timed
 return {'label':label,'exit':code,'counts':counts,'failed':failed,'timed_out':timed,'complete':complete,'seconds':round(time.monotonic()-start,3),'tap_sha256':hashlib.sha256((out/(label+'.tap')).read_bytes()).hexdigest()}
try:
 raw=subprocess.check_output(['git','archive','--format=tar',head],cwd=source)
 with tarfile.open(fileobj=io.BytesIO(raw)) as t:
  assert all(not Path(m.name).is_absolute() and '..' not in Path(m.name).parts for m in t.getmembers())
  t.extractall(tmp,filter='data')
 (tmp/'node_modules/@g-group').mkdir(parents=True)
 for dep in (source/'node_modules').iterdir():
  if dep.name=='@g-group' or dep.name.startswith('.'):continue
  (tmp/'node_modules'/dep.name).symlink_to(dep.resolve(),target_is_directory=dep.is_dir())
 for p in (tmp/'packages').iterdir():
  if (p/'package.json').exists():
   name=json.loads((p/'package.json').read_text()).get('name','')
   if name.startswith('@g-group/'):
    link=tmp/'node_modules'/name;link.symlink_to(p,target_is_directory=True);assert link.resolve()==p.resolve()
 baseline=execute('baseline');(out/'baseline.json').write_text(json.dumps(baseline,indent=2)+'\n');print(json.dumps({'baseline':baseline}),flush=True)
 assert baseline['exit']==0 and baseline['complete'] and baseline['counts']['pass']==plan['expected_total_tests'],'baseline is not complete green'
 originals={e['file']:(tmp/e['file']).read_text() for m in plan['mutants'] for e in m['edits']}
 for m in plan['mutants']:
  for f,text in originals.items():(tmp/f).write_text(text)
  for e in m['edits']:
   p=tmp/e['file'];text=p.read_text();assert text.count(e['from'])==1,(m['id'],e['file'],'anchor not unique');p.write_text(text.replace(e['from'],e['to']))
  r=execute(m['id']);r.update(id=m['id'],criterion=m['criterion'],expected_test=m['expected_test'])
  r['killed']=r['exit']==1 and r['complete'] and any(f['name']==m['expected_test'] and f['assertion'] for f in r['failed'])
  r['collateral_failures']=[f for f in r['failed'] if f['name']!=m['expected_test']]
  rows.append(r);(out/'events.jsonl').open('a').write(json.dumps(r,ensure_ascii=False)+'\n');print(json.dumps(r,ensure_ascii=False),flush=True)
 unchanged=subprocess.check_output(['git','rev-parse','HEAD'],cwd=source,text=True).strip()==head and all((source/f).is_file() and hashlib.sha256((source/f).read_bytes()).hexdigest()==h for f,h in seal.items())
 summary={'head':head,'summary':{'total':len(rows),'killed':sum(r['killed'] for r in rows),'survived_or_invalid':sum(not r['killed'] for r in rows)},'source_unchanged':unchanged,'rows':rows}
 (out/'mutations.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2)+'\n');print(json.dumps({'summary':summary['summary'],'source_unchanged':unchanged}),flush=True)
 sys.exit(0 if unchanged and all(r['killed'] for r in rows) else 1)
finally:shutil.rmtree(tmp)
