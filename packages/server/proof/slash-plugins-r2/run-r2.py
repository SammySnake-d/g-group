# PR85 第 2 轮返修云端复跑:box2 /workspace/claude-author-pr85-r2,共享 /workspace/.heavy.lock 由外层 flock 排队。
# 八步:green(两份测试文件)、calibration-red(472eaed 直通桩)、real-red(15fa0b7:新测试放在 230ed1c9 的实现上)、
# 变异 38(原样副本作正对照)、生产路径 proof、typecheck、lint、全量 npm test。每步原始输出落 out/<名>.log。
from pathlib import Path
import subprocess, os, sys, json, time, hashlib, re
root = Path('/workspace/claude-author-pr85-r2'); repo = root/'repo'; out = root/'out'; out.mkdir(parents=True, exist_ok=True)
HEAD, CAL_RED, REAL_RED, REVIEWED, BASE = sys.argv[1:6]
A = 'packages/server/src/slash-commands.test.ts'; B = 'packages/server/src/slash-commands-boundaries.test.ts'
def sh(cmd, cwd=None): return subprocess.run(cmd, cwd=cwd, check=True)
def rev(r, cwd=repo): return subprocess.check_output(['git', 'rev-parse', r], cwd=cwd, text=True).strip()
def deps(d):
    mods = d/'node_modules'; mods.mkdir(exist_ok=True); (mods/'@g-group').mkdir(exist_ok=True)
    for p in (repo/'node_modules').iterdir():
        if p.name in ('@g-group', '.bin') or p.name.startswith('.'): continue
        q = mods/p.name
        if not q.exists(): q.symlink_to(p.resolve())
    for p in (d/'packages').iterdir():
        q = mods/'@g-group'/p.name
        if p.is_dir() and (p/'package.json').exists() and not q.exists(): q.symlink_to(Path('..')/'..'/'packages'/p.name)
assert rev('HEAD') == HEAD, rev('HEAD')
assert subprocess.check_output(['git', 'status', '--porcelain', '--untracked-files=no'], cwd=repo, text=True) == ''
trees = {}
for name, commit in (('cal-red', CAL_RED), ('real-red', REAL_RED)):
    d = root/name
    if not d.exists(): sh(['git', 'worktree', 'add', '--detach', str(d), commit], repo)
    assert rev('HEAD', d) == commit; deps(d); trees[name] = d
# 真实红的实现必须就是审查提交的实现:15fa0b7 与 230ed1c9 除新测试文件外没有差异
real_diff = subprocess.check_output(['git', 'diff', '--name-only', REVIEWED, REAL_RED], cwd=repo, text=True).split()
assert real_diff == [B], real_diff
# 还原提交之后生产代码与修复版逐字节相同;校准红只动一个生产文件、两份测试文件与现在相同
fix = subprocess.check_output(['git', 'log', '--format=%H', '-1', HEAD, '--', 'packages/server/src/slash-commands.ts'], cwd=repo, text=True).strip()
cal_diff = subprocess.check_output(['git', 'diff', '--name-only', CAL_RED, HEAD, '--', 'packages', ':(exclude)packages/server/proof'], cwd=repo, text=True).split()
assert cal_diff == ['packages/server/src/slash-commands.ts'], cal_diff
tmp = root/'tmp'; tmp.mkdir(exist_ok=True)
env = {k: v for k, v in os.environ.items() if not k.lower().endswith('_proxy')}
env['TMPDIR'] = str(tmp); env['MUT_OUT'] = str(out/'mutations')
results = []
def run(name, cmd, cwd=repo, want=0, timeout=1500):
    start = time.time(); log = out/(name + '.log')
    with log.open('w') as f: r = subprocess.run(cmd, cwd=cwd, stdout=f, stderr=subprocess.STDOUT, timeout=timeout, env=env)
    item = {'name': name, 'command': cmd, 'cwd': str(cwd), 'exit_code': r.returncode, 'expected_exit': want, 'seconds': round(time.time() - start, 3), 'log_sha256': hashlib.sha256(log.read_bytes()).hexdigest()}
    results.append(item); (out/'status.json').write_text(json.dumps({'head': HEAD, 'results': results}, indent=2) + '\n'); print(json.dumps(item), flush=True)
    if r.returncode != want: raise RuntimeError(f'{name}: exit {r.returncode}, expected {want}')
    return log.read_text()
def tap(text):
    ok = re.findall(r'^ok \d+ - (.+)$', text, re.M); bad = []
    for m in re.finditer(r'^not ok \d+ - (.+)$', text, re.M):
        nxt = [n for n in (text.find('\n# Subtest:', m.start()), text.find('\n1..', m.start()), len(text)) if n >= m.start()]
        bad.append({'name': m.group(1), 'assertion': bool(re.search(r'\bERR_ASSERTION\b', text[m.start():min(nxt)]))})
    return ok, bad
error = None; summary = {}
try:
    t = ['node', '--test', '--test-concurrency=1', '--test-timeout=120000', '--test-force-exit', '--test-reporter=tap']
    gp, gf = tap(run('green', t + [A, B])); assert len(gp) == 31 and not gf, (len(gp), gf)
    cp, cf = tap(run('calibration-red', t + [A, B], trees['cal-red'], 1)); assert not cp and sorted(x['name'] for x in cf) == sorted(gp), (cp, len(cf))
    rp, rf = tap(run('real-red', t + [B], trees['real-red'], 1))
    assert len(rp) == 8 and len(rf) == 7 and all(x['assertion'] for x in rf) and all(re.match(r'P7 返修 R1-0[1-4] ', x['name']) for x in rf), (rp, rf)
    summary = {'green_pass': gp, 'calibration_red': {'commit': CAL_RED, 'failed': cf, 'passed': cp}, 'real_red': {'commit': REAL_RED, 'implementation_of': REVIEWED, 'failed': rf, 'passed': rp}}
    (out/'red-green.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2) + '\n')
    run('mutations', ['node', 'packages/server/proof/slash-plugins-mutations.mjs'])
    run('production', ['node', 'packages/server/proof/slash-plugins-real.ts'])
    run('typecheck', ['npm', 'run', '-s', 'typecheck'])
    run('lint', ['npm', 'run', '-s', 'lint'])
    run('full', ['npm', 'test', '--silent'], timeout=3000)
except Exception as e:
    error = repr(e); print('ERROR', error, flush=True)
finally:
    clean = subprocess.check_output(['git', 'status', '--porcelain', '--untracked-files=no'], cwd=repo, text=True) == '' and rev('HEAD') == HEAD
    result = {'head': HEAD, 'base': BASE, 'reviewed': REVIEWED, 'calibration_red': CAL_RED, 'real_red': REAL_RED, 'last_fix_of_slash_commands': fix, 'node': subprocess.check_output(['node', '--version'], text=True).strip(), 'host': 'box2', 'results': results, 'error': error, 'source_unchanged': clean, 'complete': error is None and len(results) == 8}
    (out/'result.json').write_text(json.dumps(result, indent=2) + '\n'); print(json.dumps(result), flush=True)
sys.exit(0 if error is None else 1)
