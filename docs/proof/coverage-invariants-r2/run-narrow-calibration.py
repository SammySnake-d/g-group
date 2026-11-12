from pathlib import Path
import json, subprocess, tempfile, shutil, re, hashlib, time
ROOT=Path('/private/tmp/gg-req-invariants-r2-resume-20261113')
OUT=Path(__file__).resolve().parent
PLAN=json.loads((OUT/'r1-counterexamples-plan.json').read_text())
assert subprocess.check_output(['git','rev-parse','--show-toplevel'],cwd=ROOT,text=True).strip()==str(ROOT)
FILES=[p for p in subprocess.check_output(['git','ls-files','-z'],cwd=ROOT).decode().split('\0') if p]
sha=lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
frozen={p:sha(ROOT/p) for p in FILES}
SCRATCH=Path(tempfile.mkdtemp(prefix='gg-q02-r2-final-calibration-',dir='/private/tmp'))
CMD=['node','--test','--test-concurrency=1','--test-timeout=120000','--test-force-exit','--test-reporter=tap',PLAN['test_file']]
report={'candidate':str(ROOT),'head':subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip(),'scratch':str(SCRATCH),'node':subprocess.check_output(['node','--version'],text=True).strip(),'test_sha256':frozen[PLAN['test_file']],'host_sha256':frozen['packages/server/src/host.ts'],'scope':'Only the four Q02 tests, clean plus exact three reviewer counterexamples; not full regression or original eight mutants.','results':[]}
for mutant in [None]+PLAN['mutants']:
    name=mutant['id'] if mutant else 'baseline'; d=SCRATCH/name;d.mkdir()
    for n in FILES:
        q=d/n;q.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(ROOT/n,q)
    (d/'node_modules').mkdir()
    for p in (ROOT/'node_modules').iterdir():
        if p.name!='@g-group':(d/'node_modules'/p.name).symlink_to(p,target_is_directory=p.is_dir())
    (d/'node_modules/@g-group').mkdir()
    for p in (d/'packages').iterdir():
        if (p/'package.json').is_file():
            pkg=json.loads((p/'package.json').read_text()).get('name','')
            if pkg.startswith('@g-group/'):(d/'node_modules'/pkg).symlink_to(p,target_is_directory=True)
    if mutant:
        p=d/mutant['file'];s=p.read_text();assert s.count(mutant['from'])==1;p.write_text(s.replace(mutant['from'],mutant['to']))
    started=time.monotonic();run=subprocess.run(CMD,cwd=d,text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=180)
    log=OUT/f'final-{name}.tap';log.write_text(run.stdout)
    counts={k:int(v) for k,v in re.findall(r'^# (tests|pass|fail|cancelled|skipped|todo) (\d+)$',run.stdout,re.M)}
    complete=counts.get('tests')==4 and counts.get('pass',-1)+counts.get('fail',-1)==4 and all(counts.get(k)==0 for k in ['skipped','cancelled','todo'])
    failed=[];assertion=[]
    for b in re.split(r'^# Subtest: ',run.stdout,flags=re.M)[1:]:
        title=b.splitlines()[0]
        if '\nnot ok ' in b:
            failed.append(title)
            if "code: 'ERR_ASSERTION'" in b:assertion.append(title)
    valid=(run.returncode==0 and counts.get('pass')==4) if not mutant else run.returncode==1 and mutant['expected_test'] in assertion
    result={'id':name,'command':CMD,'exit':run.returncode,'seconds':round(time.monotonic()-started,3),'counts':counts,'complete_suite':complete,'failed_tests':failed,'ERR_ASSERTION_tests':assertion,'expected_test':mutant['expected_test'] if mutant else None,'accepted':complete and valid,'log':str(log),'log_sha256':sha(log)}
    report['results'].append(result)
    (OUT/'final-narrow-calibration.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps(result,ensure_ascii=False),flush=True)
    assert result['accepted'],name+' did not meet the registered oracle'
report['source_unchanged']=all(sha(ROOT/p)==h for p,h in frozen.items())
report['complete']=report['source_unchanged'] and all(x['accepted'] for x in report['results']) and len(report['results'])==4
(OUT/'final-narrow-calibration.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
assert report['complete']
