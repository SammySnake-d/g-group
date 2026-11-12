import assert from "node:assert/strict";
import { test } from "node:test";
import { processTable, stillAlive, treeByPgrep, treeOf } from "./procgroup.ts";
test("S-PROC-TREE-01 AC-23:后代按父子链找(含脱组的),同组成员也算,僵尸不算;pid 复用到别的进程组不算还活着;读不到进程表给 null 不给空表", () => {
  const table = processTable(() => ["  100     1   100 S", "  101   100   100 S", "  102   101   102 Ss", "  103   102   102 S", "  104     1   100 S", "  105   100   100 Z", "  200     1   200 S", "garbage"].join("\n"));
  assert.equal(table?.length, 7);
  assert.deepEqual(treeOf(100, table!).map((r) => r.pid).sort(), [101, 102, 103, 104]);
  assert.deepEqual(treeOf(200, table!), []);
  const known = table!.find((r) => r.pid === 103)!;
  assert.equal(stillAlive(known, table!), true);
  assert.equal(stillAlive(known, processTable(() => "  103     1   999 S")!), false);
  assert.equal(stillAlive(known, processTable(() => "  103   102   102 Z")!), false);
  assert.equal(stillAlive(known, []), false);
  assert.equal(processTable(() => { throw new Error("ps 不可用"); }), null);
  assert.deepEqual(table![0], { pid: 100, ppid: 1, pgid: 100, stat: "S" });
});

test("S-PROC-TREE-02 AC-23:ps 读不到时按 pgrep 逐层找后代与同组成员;pgrep 本身失败给 null(不能当成没有子进程)", () => {
  const answers: Record<string, number[] | null> = { "-P 100": [101, 104], "-P 101": [102], "-P 102": [], "-P 104": [], "-g 100": [101, 105, 100] };
  const asked: string[] = [];
  const rows = treeByPgrep(100, (args) => { asked.push(args.join(" ")); return answers[args.join(" ")] ?? []; });
  assert.deepEqual(rows?.map((r) => [r.pid, r.ppid, r.pgid]), [[101, 100, -1], [104, 100, -1], [102, 101, -1], [105, -1, 100]]);
  assert.deepEqual(asked, ["-P 100", "-P 101", "-P 104", "-P 102", "-g 100"]);
  assert.equal(treeByPgrep(100, (args) => (args[0] === "-g" ? null : [])), null);
  assert.equal(treeByPgrep(100, () => null), null);
});
