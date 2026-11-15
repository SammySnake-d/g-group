import hashlib
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone

ROOT = pathlib.Path('/private/tmp/gg-pr75-gate-witnesses-dyugzcdc')
REPO = ROOT / 'repo'
EVIDENCE = ROOT / 'evidence'
NODE = '/opt/homebrew/bin/node'
BASE = '3efafc167a80f944a5cd7b839a3c7a9fc6ae3e53'
GUARD = pathlib.Path('/Users/snakesammy/.mirasim/assistants/deliverables/g-group-closed-loop/a5-length-c30-live-20261116/signal-guard-prepush/process-guard-v4.mjs')
phase = sys.argv[1]
if phase not in ['baseline', 'strengthened']:
    raise SystemExit('使用 baseline|strengthened')
OUT = EVIDENCE / (phase + '-safe')
OUT.mkdir()
TMP = pathlib.Path(tempfile.mkdtemp(prefix='private-test-tmp-', dir=OUT))
TMP.chmod(0o700)
env = os.environ.copy()
env.update(NODE_OPTIONS='--import=' + str(GUARD), GG_A5_GUARD_LOG=str(OUT / 'signals.ndjson'), TMPDIR=str(TMP), GG_TEST_RUN_TMP=str(TMP))

def git(*args):
    return subprocess.check_output(['git', '-C', str(REPO), *args], text=True).strip()

def sha(path):
    return hashlib.sha256(pathlib.Path(path).read_bytes()).hexdigest()

head = git('rev-parse', 'HEAD')
if phase == 'baseline' and head != BASE:
    raise SystemExit('未改基线HEAD已变化')
if git('status', '--porcelain'):
    raise SystemExit('候选树不干净，不能冻结运行')
inputs = [
    'packages/domain/src/task.test.ts', 'packages/kernel/src/attention-retry.test.ts',
    'packages/server/src/delivery-t8a.test.ts', 'packages/server/src/desk-fake.test.ts',
    'packages/server/src/start.test.ts', 'packages/server/src/host.ts',
    'packages/server/src/fakes.ts', 'packages/domain/src/task.ts',
    'packages/kernel/src/attention.ts', 'scripts/gates/gates.ts',
    'scripts/gates/lib.ts', 'scripts/gates/testlint.ts', 'package-lock.json',
]
frozen = {file: sha(REPO / file) for file in inputs}
runner_files = ['witness-tools.mjs', 'forbid-os-signals.mjs', 'run-witnesses.py', 'run-witnesses-safe.py']
runner_hashes = {file: sha(EVIDENCE / file) for file in runner_files}
external_hashes = {str(file): sha(file) for file in [GUARD, GUARD.parent / 'native/table.node']}

def check():
    if git('rev-parse', 'HEAD') != head or git('status', '--porcelain'):
        raise RuntimeError('候选源码或HEAD在运行期间变化')
    for file, digest in frozen.items():
        if sha(REPO / file) != digest:
            raise RuntimeError('冻结输入变化:' + file)
    for file, digest in runner_hashes.items():
        if sha(EVIDENCE / file) != digest:
            raise RuntimeError('冻结runner变化:' + file)
    for file, digest in external_hashes.items():
        if sha(file) != digest:
            raise RuntimeError('冻结护栏变化:' + file)

mutation = EVIDENCE / (phase + '-mutation')
pattern = '^(AC-28① 交付待确认没有归档出口|R13 进程内改写 TABLE/行/格/STATES/EVENT_KINDS)'
test_args = [NODE, '--experimental-test-isolation=none', '--test', '--test-reporter=tap', '--test-concurrency=1', '--test-timeout=30000']
mut_args = [NODE, '--experimental-test-isolation=none', '--import', './__gate_arm.mjs', '--test', '--test-reporter=tap', '--test-concurrency=1', '--test-timeout=2000']
steps = [
    ('prepare', [NODE, str(EVIDENCE / 'witness-tools.mjs'), 'prepare', phase], REPO, [0]),
    ('attention-real', test_args + ['packages/kernel/src/attention-retry.test.ts'], REPO, [0]),
    ('task-real', test_args + ['--test-name-pattern=' + pattern, 'packages/domain/src/task.test.ts'], REPO, [0]),
    ('server-real', test_args + ['packages/server/src/delivery-t8a.test.ts', 'packages/server/src/desk-fake.test.ts', 'packages/server/src/start.test.ts'], REPO, [0]),
    ('static', [NODE, str(EVIDENCE / 'witness-tools.mjs'), 'static', phase], REPO, [1] if phase == 'baseline' else [0]),
    ('attention-mutation', mut_args + ['packages/kernel/src/attention-retry.test.ts'], mutation, [1]),
    ('task-mutation', mut_args + ['--test-name-pattern=' + pattern, 'packages/domain/src/task.test.ts'], mutation, [0] if phase == 'baseline' else [1]),
]
if phase == 'baseline':
    # 其他未改基线步骤已完成，保留先前结果，只纠正失败的执行器接线。
    steps = [step for step in steps if step[0] == 'server-real']
else:
    steps += [
        ('typecheck', [NODE, str(REPO / 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.json'], REPO, [0]),
        ('lint', [str(REPO / 'node_modules/.bin/biome'), 'lint', '--error-on-warnings', *inputs[:5]], REPO, [0]),
    ]
metadata = {
    'phase': phase, 'base': BASE, 'source_head': head, 'node': NODE,
    'input_hashes': frozen, 'runner_hashes': runner_hashes, 'external_hashes': external_hashes,
    'env': {key: env[key] for key in ['NODE_OPTIONS', 'GG_A5_GUARD_LOG', 'TMPDIR', 'GG_TEST_RUN_TMP']},
    'commands': [{'name': name, 'command': cmd, 'cwd': str(cwd), 'expected_exits': expected} for name, cmd, cwd, expected in steps],
    'not_first_historical_red': True, 'formal_gates_started': False,
    'correction': '仅外置执行器解除对合法只读spawnSync的误挡，复用已验证自建进程信号隔离器；原两次exit1保留',
}
(OUT / 'commands.json').write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + '\n')
results = []
supervisor_exit = 0
try:
    for name, command, cwd, expected in steps:
        check()
        start = time.monotonic()
        entry = {'event': 'command_execution', 'name': name, 'command': command, 'cwd': str(cwd), 'started_at': datetime.now(timezone.utc).isoformat()}
        print(json.dumps(entry, ensure_ascii=False), flush=True)
        with (OUT / (name + '.log')).open('wb') as log:
            process = subprocess.Popen(command, cwd=cwd, env=env, stdout=log, stderr=subprocess.STDOUT)
            entry['pid'] = process.pid
            (OUT / (name + '.pid')).write_text(str(process.pid) + '\n')
            code = process.wait()
        entry.update(exit=code, elapsed_s=round(time.monotonic() - start, 3), finished_at=datetime.now(timezone.utc).isoformat())
        (OUT / (name + '.exit')).write_text(str(code) + '\n')
        results.append(entry)
        (OUT / 'executions.json').write_text(json.dumps(results, ensure_ascii=False, indent=2) + '\n')
        print(json.dumps({'name': name, 'exit': code, 'elapsed_s': entry['elapsed_s']}, ensure_ascii=False), flush=True)
        check()
        if code not in expected:
            supervisor_exit = 1
            break
    check()
    signals = [json.loads(line) for line in (OUT / 'signals.ndjson').read_text().splitlines()] if (OUT / 'signals.ndjson').exists() else []
    signal_events = [event for event in signals if event.get('event') in ['signal', 'self-signal']]
    (OUT / 'freeze-after.json').write_text(json.dumps({'source_head': head, 'input_hashes': frozen, 'runner_hashes': runner_hashes, 'external_hashes': external_hashes, 'unchanged': True, 'signal_events': signal_events}, ensure_ascii=False, indent=2) + '\n')
    if signal_events:
        print('发现OS信号事件，不能称无信号纯定向运行', flush=True)
        supervisor_exit = 1
except Exception as error:
    supervisor_exit = 2
    (OUT / 'executor-error.json').write_text(json.dumps({'error': repr(error)}, ensure_ascii=False, indent=2) + '\n')
    raise
finally:
    (OUT / 'supervisor.exit').write_text(str(supervisor_exit) + '\n')
raise SystemExit(supervisor_exit)
