import pathlib,subprocess,json,time,datetime
r=pathlib.Path('/private/tmp/gg-pr75-gate-witnesses-dyugzcdc/evidence/baseline-pure-continuation-20261116T061830')
steps=[{'name': 'static', 'command': ['/opt/homebrew/bin/node', '/private/tmp/gg-pr75-gate-witnesses-dyugzcdc/evidence/witness-tools.mjs', 'static', 'baseline'], 'cwd': '/private/tmp/gg-pr75-gate-witnesses-dyugzcdc/repo', 'expected_exits': [1]}, {'name': 'attention-mutation', 'command': ['/opt/homebrew/bin/node', '--experimental-test-isolation=none', '--import', '/private/tmp/gg-pr75-gate-witnesses-dyugzcdc/evidence/forbid-os-signals.mjs', '--import', './__gate_arm.mjs', '--test', '--test-reporter=tap', '--test-concurrency=1', '--test-timeout=2000', 'packages/kernel/src/attention-retry.test.ts'], 'cwd': '/private/tmp/gg-pr75-gate-witnesses-dyugzcdc/evidence/baseline-mutation', 'expected_exits': [1]}, {'name': 'task-mutation', 'command': ['/opt/homebrew/bin/node', '--experimental-test-isolation=none', '--import', '/private/tmp/gg-pr75-gate-witnesses-dyugzcdc/evidence/forbid-os-signals.mjs', '--import', './__gate_arm.mjs', '--test', '--test-reporter=tap', '--test-concurrency=1', '--test-timeout=2000', '--test-name-pattern=^(AC-28① 交付待确认没有归档出口|R13 进程内改写 TABLE/行/格/STATES/EVENT_KINDS)', 'packages/domain/src/task.test.ts'], 'cwd': '/private/tmp/gg-pr75-gate-witnesses-dyugzcdc/evidence/baseline-mutation', 'expected_exits': [0]}]
results=[]
for s in steps:
 start=time.time()
 with (r/(s["name"]+".log")).open("wb") as log:
  p=subprocess.Popen(s["command"],cwd=s["cwd"],stdout=log,stderr=subprocess.STDOUT)
  (r/(s["name"]+".pid")).write_text(str(p.pid)+"\n")
  rc=p.wait()
 (r/(s["name"]+".exit")).write_text(str(rc)+"\n")
 results.append(dict(s,event="command_execution",pid=p.pid,exit=rc,duration_s=time.time()-start))
 (r/"command_executions.json").write_text(json.dumps(results,ensure_ascii=False,indent=2)+"\n")
 if rc not in s["expected_exits"]: break
(r/"supervisor.exit").write_text(str(int(any(x["exit"] not in x["expected_exits"] for x in results)))+"\n")
