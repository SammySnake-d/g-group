import subprocess,json,pathlib,time,os
r=pathlib.Path('/private/tmp/gg-pr75-gate-witnesses-dyugzcdc/evidence/resume-command-20261116T061601')
argv=['/opt/homebrew/bin/node', '--experimental-test-isolation=none', '--import', '/private/tmp/gg-pr75-gate-witnesses-dyugzcdc/evidence/forbid-os-signals.mjs', '--test', '--test-reporter=tap', '--test-concurrency=1', '--test-timeout=30000', 'packages/server/src/delivery-t8a.test.ts', 'packages/server/src/desk-fake.test.ts', 'packages/server/src/start.test.ts']
cwd='/private/tmp/gg-pr75-gate-witnesses-dyugzcdc/repo'
start=time.time()
with (r/"command.log").open("wb") as log:
 p=subprocess.Popen(argv,cwd=cwd,stdout=log,stderr=subprocess.STDOUT,env=os.environ.copy())
 (r/"command.pid").write_text(str(p.pid)+"\n")
 rc=p.wait()
 (r/"command.exit").write_text(str(rc)+"\n")
 (r/"command_execution.json").write_text(json.dumps({"command":argv,"cwd":cwd,"pid":p.pid,"exit":rc,"duration_s":time.time()-start},indent=2)+"\n")
