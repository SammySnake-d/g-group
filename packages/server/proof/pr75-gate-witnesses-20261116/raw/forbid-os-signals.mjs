import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import cp from 'node:child_process';
const log = '/private/tmp/gg-pr75-gate-witnesses-dyugzcdc/evidence/forbidden-attempts.jsonl';
const fail = (what) => {
  fs.appendFileSync(log, JSON.stringify({ at: new Date().toISOString(), what }) + '\n');
  throw new Error(`纯定向校准禁止操作系统进程调用:${what}`);
};
process.kill = () => fail('process.kill');
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) cp[name] = () => fail(`child_process.${name}`);
syncBuiltinESMExports();
