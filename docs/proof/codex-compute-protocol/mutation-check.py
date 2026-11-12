import pathlib,subprocess,json,hashlib,time,re,sys,os,shutil
repo=pathlib.Path(sys.argv[1]).resolve();out=pathlib.Path(sys.argv[2]).resolve();out.mkdir(parents=True,exist_ok=True)
file='packages/adapter-codex-compute/src/protocol.ts';test='packages/adapter-codex-compute/src/protocol.test.ts'
original=(repo/file).read_text();testbytes=(repo/test).read_bytes();head=subprocess.check_output(['git','rev-parse','HEAD'],cwd=repo,text=True).strip();rows=[];errors=[]
sha=lambda b:hashlib.sha256(b).hexdigest()
mutations=[
 ('M01-initialized-order','CXP-01','if (!send({ method: "initialized", params: {} }))','if (!true)'),
 ('M02-resume-creates-replacement','CXP-03','request("thread/resume",','request("thread/start",'),
 ('M03-expected-turn-id','CXP-04','expectedTurnId, input:','expectedTurnId: "foreign-wire-turn", input:'),
 ('M04-interrupt-ack-is-terminal','CXP-13','let timer: NodeJS.Timeout | undefined;','return { ok: true, value: { status: "interrupted" } };\n      let timer: NodeJS.Timeout | undefined;'),
 ('M05-unknown-model-accepted','CXP-05','return no("requested model is not in the explicit owner catalog");','return null;'),
 ('M06-nonempty-tools-accepted','CXP-06','return no("native per-tool authorization is not mapped; Host/G2 policy must not be guessed");','return null;'),
 ('M07-effort-fallback','CXP-07','return no("requested effort is not supported by the explicit owner catalog");','return null;'),
 ('M08-foreign-rpc-id-consumed','CXP-12','const p = pending.get(msg.id);','const p = pending.values().next().value;'),
 ('M09-foreign-thread-consumed','CXP-12',' || msg.params.threadId !== threadId',''),
 ('M10-foreign-turn-consumed','CXP-12','const turn = turns.get(native.id);','const turn = turns.values().next().value;'),
 ('M11-main-exit-zero-is-success','CXP-08','turn.result = { ok: true, value: { computeId: threadId!, kind: "failed", reason: wireFailure ?? "native process exited before matching turn/completed", code: wireFailure ? null : code, signal: wireFailure ? null : signal, violations: [] } };','turn.result = { ok: true, value: { computeId: threadId!, kind: "completed", result: "" } };'),
 ('M12-main-only-quiescence','CXP-11','const r = await cleanup.quiesce(timeoutMs, timeoutMs + 500);','await new Promise<void>((resolve) => { if (child!.exitCode !== null || child!.signalCode !== null) resolve(); else child!.once("close", () => resolve()); }); const r = { ok: true as const, killed: 0 };'),
 ('M13-concurrent-native-turns','CXP-14','if (starting || [...turns.values()].some((t) => t.result === null)) return no("native turn already active");',''),
 ('M14-ignore-next-turn-model','CXP-15','model: turn.model, effort: turn.effort','model: "probe-A", effort: "low"'),
 ('M15-corrupt-wire-hangs','CXP-16','wireFailure = "invalid native JSON"; failPending(wireFailure); cleanup?.requestStop(50);','failPending("invalid native JSON");'),
 ('M16-owner-realpath-throws','CXP-17','try {\n        if (typeof r.value.codexHome !== "string" || realpathSync(r.value.codexHome) !== realpathSync(options.configDir)) return no("native config owner mismatch");\n      } catch { return no("native config owner mismatch"); }','if (typeof r.value.codexHome !== "string" || realpathSync(r.value.codexHome) !== realpathSync(options.configDir)) return no("native config owner mismatch");'),
 ('M17-approval-is-authorized','CXP-10','send({ id: msg.id, error: { code: -32601, message: "g-group protocol slice has no Host approval authority" } });','send({ id: msg.id, result: {} });'),
]
for name,designated,old,new in mutations:
 copy=out/name;log=out/(name+'.log');event={'name':name,'designated':designated,'sourceHead':head,'startedAt':time.time(),'testSha256':sha(testbytes),'beforeSha256':sha(original.encode()),'mutationOccurrences':original.count(old),'command':['node','--test','--test-reporter=tap',test]}
 try:
  assert original.count(old)==1,(name,original.count(old));assert not copy.exists(),str(copy)
  subprocess.run(['git','clone','--quiet','--no-hardlinks',str(repo),str(copy)],check=True);subprocess.run(['git','checkout','--quiet','--detach',head],cwd=copy,check=True);(copy/'node_modules').symlink_to(repo/'node_modules',target_is_directory=True)
  mutated=original.replace(old,new);(copy/file).write_text(mutated);assert (copy/test).read_bytes()==testbytes;event['afterSha256']=sha(mutated.encode());print('command_execution',json.dumps({**event,'cwd':str(copy)}),flush=True)
  with log.open('wb') as f:
   proc=subprocess.Popen(event['command'],cwd=copy,stdout=f,stderr=subprocess.STDOUT,start_new_session=True)
   try:event['exit']=proc.wait(timeout=90)
   except subprocess.TimeoutExpired:os.killpg(proc.pid,15);event['exit']=proc.wait(timeout=10);event['timedOut']=True
  text=log.read_text();event['tap']={k:int(m[-1]) for k in ['tests','pass','fail','cancelled','skipped','todo'] if (m:=re.findall(r'^# '+k+r'\s+(\d+)\s*$',text,re.M))};event['failedNames']=re.findall(r'^not ok \d+ - ([^\n]+)',text,re.M);event['designatedAssertion']=bool(re.search(r'^not ok \d+ - '+re.escape(designated)+r"\b[^\n]*\n(?:(?!^ok |^not ok ).)*?code: 'ERR_ASSERTION'",text,re.M|re.S));event['testBytesUnchanged']=(copy/test).read_bytes()==testbytes;event['logSha256']=sha(log.read_bytes())
  event['killed']=event['exit']==1 and not event.get('timedOut') and event['tap'].get('tests')==17 and all(event['tap'].get(k)==0 for k in ['cancelled','skipped','todo']) and event['designatedAssertion'] and event['testBytesUnchanged']
 except BaseException as e:event['executorError']=repr(e);event['killed']=False
 event['finishedAt']=time.time();rows.append(event);(out/'rows.json').write_text(json.dumps(rows,indent=2)+'\n');print('MUTANT_RESULT',json.dumps(event),flush=True)
 if not event['killed']:errors.append(name)
result={'head':head,'results':rows,'expected':len(mutations),'killed':sum(r['killed'] for r in rows),'notKilled':errors,'sourceUnchanged':(repo/file).read_text()==original and (repo/test).read_bytes()==testbytes,'dependencyStrategy':'mutant clones share sealed unmodified candidate dependency tree; each mutated source and full17 test body copied, candidate full/baseline install their own dependencies','complete':not errors and len(rows)==len(mutations)}
(out/'result.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps({k:v for k,v in result.items() if k!='results'}));sys.exit(0 if result['complete'] else 1)
