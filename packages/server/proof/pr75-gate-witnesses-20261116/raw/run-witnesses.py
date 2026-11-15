import hashlib
import json
import pathlib
import subprocess
import sys
import time
from datetime import datetime, timezone

ROOT = pathlib.Path('/private/tmp/gg-pr75-gate-witnesses-dyugzcdc')
REPO = ROOT / 'repo'
EVIDENCE = ROOT / 'evidence'
NODE = '/opt/homebrew/bin/node'
BASE = '3efafc167a80f944a5cd7b839a3c7a9fc6ae3e53'
phase = sys.argv[1]
if phase not in ['baseline', 'strengthened']:
    raise SystemExit('使用 baseline|strengthened')

def git(*args):
    return subprocess.check_output(['git', '-C', str(REPO), *args], text=True).strip()

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
frozen = {file: hashlib.sha256((REPO / file).read_bytes()).hexdigest() for file in inputs}
runner_files = ['witness-tools.mjs', 'forbid-os-signals.mjs', 'run-witnesses.py']
runner_hashes = {file: hashlib.sha256((EVIDENCE / file).read_bytes()).hexdigest() for file in runner_files}
def check():
    if git('rev-parse', 'HEAD') != head:
        raise RuntimeError('候选HEAD在运行期间变化')
    for file, digest in frozen.items():
        if hashlib.sha256((REPO / file).read_bytes()).hexdigest() != digest:
            raise RuntimeError('冻结输入变化:' + file)
    for file, digest in runner_hashes.items():
        if hashlib.sha256((EVIDENCE / file).read_bytes()).hexdigest() != digest:
            raise RuntimeError('冻结runner变化:' + file)

guard = str(EVIDENCE / 'forbid-os-signals.mjs')
mutation = EVIDENCE / (phase + '-mutation')
pattern = '^(AC-28① 交付待确认没有归档出口|R13 进程内改写 TABLE/行/格/STATES/EVENT_KINDS)'
test_args = [NODE, '--experimental-test-isolation=none', '--import', guard, '--test', '--test-reporter=tap', '--test-concurrency=1', '--test-timeout=30000']
mut_args = [NODE, '--experimental-test-isolation=none', '--import', guard, '--import', './__gate_arm.mjs', '--test', '--test-reporter=tap', '--test-concurrency=1', '--test-timeout=2000']
steps = [
    ('prepare', [NODE, str(EVIDENCE / 'witness-tools.mjs'), 'prepare', phase], REPO, [0]),
    ('attention-real', test_args + ['packages/kernel/src/attention-retry.test.ts'], REPO, [0]),
    ('task-real', test_args + ['--test-name-pattern=' + pattern, 'packages/domain/src/task.test.ts'], REPO, [0]),
    ('server-real', test_args + ['packages/server/src/delivery-t8a.test.ts', 'packages/server/src/desk-fake.test.ts', 'packages/server/src/start.test.ts'], REPO, [0]),
    ('static', [NODE, str(EVIDENCE / 'witness-tools.mjs'), 'static', phase], REPO, [1] if phase == 'baseline' else [0]),
    ('attention-mutation', mut_args + ['packages/kernel/src/attention-retry.test.ts'], mutation, [1]),
    ('task-mutation', mut_args + ['--test-name-pattern=' + pattern, 'packages/domain/src/task.test.ts'], mutation, [0] if phase == 'baseline' else [1]),
]
if phase == 'strengthened':
    steps += [
        ('typecheck', [NODE, str(REPO / 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.json'], REPO, [0]),
        ('lint', [str(REPO / 'node_modules/.bin/biome'), 'lint', '--error-on-warnings', *inputs[:5]], REPO, [0]),
    ]
metadata = {'phase': phase, 'base': BASE, 'source_head': head, 'node': NODE, 'input_hashes': frozen, 'runner_hashes': runner_hashes, 'commands': [{'name': name, 'command': cmd, 'cwd': str(cwd), 'expected_exits': expected} for name, cmd, cwd, expected in steps], 'not_first_historical_red': True, 'formal_gates_started': False, 'os_signals_or_compute_started': False}
(EVIDENCE / (phase + '-commands.json')).write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + '\n')
results = []
supervisor_exit = 0
for name, command, cwd, expected in steps:
    check()
    start = time.monotonic()
    entry = {'event': 'command_execution', 'name': name, 'command': command, 'cwd': str(cwd), 'started_at': datetime.now(timezone.utc).isoformat()}
    print(json.dumps(entry, ensure_ascii=False), flush=True)
    with (EVIDENCE / (phase + '-' + name + '.log')).open('wb') as log:
        process = subprocess.Popen(command, cwd=cwd, stdout=log, stderr=subprocess.STDOUT)
        entry['pid'] = process.pid
        code = process.wait()
    entry.update(exit=code, elapsed_s=round(time.monotonic() - start, 3), finished_at=datetime.now(timezone.utc).isoformat())
    (EVIDENCE / (phase + '-' + name + '.exit')).write_text(str(code) + '\n')
    results.append(entry)
    (EVIDENCE / (phase + '-executions.json')).write_text(json.dumps(results, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'name': name, 'exit': code, 'elapsed_s': entry['elapsed_s']}, ensure_ascii=False), flush=True)
    check()
    if code not in expected:
        supervisor_exit = 1
        break
(EVIDENCE / (phase + '-supervisor.exit')).write_text(str(supervisor_exit) + '\n')
raise SystemExit(supervisor_exit)
