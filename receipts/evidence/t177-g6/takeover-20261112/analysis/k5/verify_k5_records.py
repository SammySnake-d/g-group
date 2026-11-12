#!/usr/bin/env python3
"""Read-only audit of four frozen G6 records; no network, writes, or model calls.

Run: python3 verify_k5_records.py
Exit 0 means the assertions about these four historical K5 false positives hold.
It does NOT mean all K5 contracts, AC-42, or any product acceptance has passed.
"""
from datetime import datetime, timezone
from pathlib import Path
import hashlib
import json
import re
import sys

RAW_ROOT = Path(sys.argv[1]) if len(sys.argv) > 1 else Path('/Users/snakesammy/.mirasim/assistants/deliverables/g-group-t177-execution/G6/runs/real/raw')
CASES = [
    dict(file='g2__workbuddy-ai_hy4free/E1-r1.json', sha256='a548d98df4fd9719feb5058e9bcadd4b215bec9d305d6a7619aeb1755c3836c3', commit='4c9a37201c42dc2587380769fb072c3f10b2c1ad', failed_call=6, coverage_id='bc78fbed5eadac267cc1800f5ddd45297797d57bbe2fe182a61f7e9efe4b7c30'),
    dict(file='g3__workbuddy-ai_hy4free/R1-r1.json', sha256='74bfe556e4da762446ba5e8f950031b038f991e1d8761132c228e5291533be61', commit='122e0d4f1f8b0415cf0c413db28fa827f1d4067b', failed_call=7, coverage_id='75b25011b646da79b7f551cf8da4a2cb9a78631bd4c0e2d6031783088e3d9e33'),
    dict(file='g3__workbuddy-ai_hy4free/E1-r1.json', sha256='465a7525b3191a3205e021ba8633281663ba7d6d34352d7179ec98a7140e90a7', commit='122e0d4f1f8b0415cf0c413db28fa827f1d4067b', failed_call=6, coverage_id='8bbda7bbd858c2fb7bfc04ef374c90e41ae964657342520974cddee968d3d129'),
    dict(file='g4on__workbuddy-ai_hy4free/E1-r1.json', sha256='74bbacf1a6a4aad8806bd122438e89fca9763f4d403edc47ff790af52aab3a3f', commit='3218bc7dcc59465146cc9455595d81a470a618ff', failed_call=6, coverage_id='14867d6636ab4d7610324765a70e90189333c20836f2434013dab04f0dfbafe1'),
]


def require(condition, message):
    if not condition:
        raise ValueError(message)


def utc(ms):
    return datetime.fromtimestamp(ms / 1000, timezone.utc).isoformat(timespec='milliseconds')


def sources(call):
    marker = '[宿主冻结的逐条来源 sources]\n'
    require(marker in call['request'], 'missing frozen source metadata')
    return json.JSONDecoder().raw_decode(call['request'].split(marker, 1)[1])[0]


def coverage_id(record, call):
    # Fixed tested MemoryCoverage.begin: sha256(JSON.stringify([contact,refs,inbox,rooms])).
    # These four cases are one DM, no inbox; this is not a general reconstruction API.
    refs = [{k: s[k] for k in ('roomId', 'seq', 'revision')} for s in sources(call)]
    refs.sort(key=lambda s: (s['roomId'], s['seq'], s['revision']))
    identity = [record['contactIds']['A'], refs, [], [record['roomIds']['dm']]]
    return hashlib.sha256(json.dumps(identity, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()


def inbound_lines(text):
    # Mechanical Python transcription of frozen capture.ts:46-75; no runner import.
    head = re.compile(r'^#(\d+) · (\S+) · .*?\((user|contact|helper|system):[^)]*\)')
    debt_head = re.compile(r'^(\S+) #(\d+) rev=\d+ \((user|contact|helper|system):[^)]*\)$')
    out, cur = [], None
    for line in text.split('\n'):
        h = head.search(line)
        d = None if h else debt_head.search(line)
        if h:
            cur = dict(roomId=h[2], seq=int(h[1]), kind=h[3], lines=[], para=False)
            out.append(cur)
        elif d:
            cur = dict(roomId=d[1], seq=int(d[2]), kind=d[3], lines=[], para=True)
            out.append(cur)
        elif re.search(r'^\[[^\]]+\]|^</?block|^〔', line):
            cur = None
        elif cur and cur['para'] and not line.strip():
            cur = None
        elif cur:
            cur['lines'].append(line)
    return [dict(roomId=m['roomId'], seq=m['seq'], kind=m['kind'], text='\n'.join(m['lines']).strip()) for m in out]


def historical_k5_violations(record):
    # Exact decision conditions from frozen contracts.ts:103-110, data only.
    violations = []
    for c in record['calls']:
        if c['cls'] != 'check' or c['outcome'] == 'ok':
            continue
        for u in (m for m in inbound_lines(c['request']) if m['kind'] == 'user'):
            ok = any(x['cls'] == 'check' and x['contact'] == c['contact'] and x['n'] > c['n'] and x['outcome'] == 'ok'
                     and any(m['text'] == u['text'] for m in inbound_lines(x['request'])) for x in record['calls'])
            refs = record['hostDebt'].get(c['contact'], {}).get('refs', []) if c['contact'] is not None else []
            debt = any(r['roomId'] == u['roomId'] and r['seq'] == u['seq'] for r in refs)
            if not ok and not debt:
                violations.append(dict(call=c['n'], roomId=u['roomId'], seq=u['seq'], text=u['text']))
    return violations


def verify(case):
    path = RAW_ROOT / case['file']
    raw = path.read_bytes()
    digest = hashlib.sha256(raw).hexdigest()
    require(digest == case['sha256'], f'raw SHA256 drift: {path}: {digest}')
    rec = json.loads(raw)
    require(rec['commit'] == case['commit'], 'tested commit changed')
    require(rec['model'] == 'workbuddy-ai/hy4free' and rec['status'] == 'timeout', 'model/status changed')
    calls = {c['n']: c for c in rec['calls']}
    failed = calls[case['failed_call']]
    require(failed['cls'] == 'check' and failed['outcome'] == 'empty', 'focused failure changed')
    parsed = historical_k5_violations(rec)
    require(len(parsed) == 1 and parsed[0]['call'] == failed['n'] and parsed[0]['seq'] == 3, 'historical K5 failure differs')
    derived = coverage_id(rec, failed)
    require(derived == case['coverage_id'], 'coverage identity reconstruction differs')
    reports = []
    for report in rec['reports']:
        if report['what'] == 'reflect-failed':
            detail = json.loads(report['detail'])
            if detail['coverageId'] == derived:
                reports.append(dict(at=report['at'], utc=utc(report['at']), **detail))
    require(len(reports) == 1, 'no unique matching reflect-failed report')
    require(reports[0]['at'] >= failed['at'] + failed['ms'], 'failure report predates response completion')
    op_name = 'edit' if rec['item'] == 'E1' else 'retract'
    operation = next(o for o in rec['ops'] if o['op'] == op_name)
    require(operation['seq'] == 1 and operation['at'] < failed['at'], 'operation target/order differs')
    rejection = [r for r in rec['reports'] if r['what'] == 'action-rejected' and '"sourceSeq":3' in r['detail']]
    require(rejection, 'expected remember sourceSeq=3 rejection not observed')
    result = dict(file=str(path), sha256=digest, bytes=len(raw), runId=rec['runId'], testedCommit=rec['commit'],
                  originalRunStatus=rec['status'], operation={**operation, 'utc': utc(operation['at'])},
                  focusedCall=dict(n=failed['n'], startUtc=utc(failed['at']), endUtc=utc(failed['at'] + failed['ms']), outcome=failed['outcome']),
                  sourceMetadata=sources(failed), derivedCoverageId=derived, matchingFailureReports=reports,
                  historicalK5Violations=parsed, finalHostDebt=rec['hostDebt']['A'],
                  rememberSourceSeq3RejectedAt=[utc(r['at']) for r in rejection])
    if rec['item'] == 'E1':
        refs = [{k: s[k] for k in ('roomId', 'seq', 'revision')} for s in sources(failed)]
        require(refs == [dict(roomId=rec['roomIds']['dm'], seq=1, revision=3)], 'edited canonical source differs')
        debt = [r for r in rec['hostDebt']['A']['refs'] if r['roomId'] == rec['roomIds']['dm'] and r['seq'] == 1 and r['state'] == 'failed']
        require(len(debt) == 2 and rec['hostDebt']['A']['counts']['failed'] == 2, 'expected canonical-source debts absent')
        require(sources(calls[3])[0]['revision'] == 1, 'old-version control differs')
        require(calls[3]['at'] + calls[3]['ms'] < operation['at'], 'old check/edit ordering differs')
        result['finding'] = '呈现事件 #3 与 canonical source #1/rev3 混用；新版本检查失败已落账，最终存在 #1 failed 引用。'
    else:
        recovery = calls[12]
        require(sources(failed) == [] and sources(recovery) == [], 'withdrawal sources are not empty')
        require(recovery['cls'] == 'check' and recovery['outcome'] == 'ok' and recovery['at'] > reports[0]['at'], 'recovery call/order differs')
        require(coverage_id(rec, recovery) == derived, 'recovery reconstructed identity differs')
        require(json.loads(recovery['text']) == dict(note=None, memories=[], personaSuggestion=None), 'recovery result differs')
        require(rec['hostDebt']['A']['counts']['ok'] == 1, 'final successful coverage count differs')
        result['recovery'] = dict(call=12, startUtc=utc(recovery['at']), endUtc=utc(recovery['at'] + recovery['ms']), outcome='ok', sourceMetadata=[], derivedCoverageId=derived, result=json.loads(recovery['text']))
        result['finding'] = '撤回事件 #3 的空来源 coverage 在 call 12 补查成功；原判据要求撤回通知文本再次出现，漏认补查。'
    require(hashlib.sha256(path.read_bytes()).hexdigest() == digest, 'raw changed during verification')
    result['rawUnchangedAfterRead'] = True
    return result


def main():
    results, errors = [], []
    for case in CASES:
        try:
            results.append(verify(case))
        except Exception as exc:
            errors.append(dict(file=case['file'], error=f'{type(exc).__name__}: {exc}'))
    print(json.dumps(dict(schema='g6-k5-four-record-readonly-audit/v1', checkedAtUtc=datetime.now(timezone.utc).isoformat(),
                         verdict='PASS_FOUR_FROZEN_FALSE_POSITIVES_ONLY' if not errors else 'FAIL',
                         verifiedRecords=len(results), expectedRecords=4, results=results, errors=errors,
                         limits=['仅核对四份固定 raw 中的四条 K5 误报，不证明全部 K5 或 AC-42 通过。',
                                 '未执行模型、宿主、测试套件或修改 runner；Python 仅重放冻结判据的读取/比较逻辑。',
                                 'hostDebt 原采集丢失 coverage ID、revision、disposition；新旧 #1 引用不能仅靠该投影区分。',
                                 'call 12 的 coverage 关联按固定宿主 identity 公式重建；原 call 记录不直接携带 coverage ID。',
                                 '保留 remember sourceSeq=3 被拒绝以及旧记忆仍 active 的独立行为边界；本附件不判其正常或已修复。']), ensure_ascii=False, indent=2))
    return 1 if errors else 0


if __name__ == '__main__':
    sys.exit(main())
