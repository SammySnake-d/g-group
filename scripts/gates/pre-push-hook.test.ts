// 推送钩子 .githooks/pre-push 的成败必须跟门禁自检的真实退出码走,输出照旧滤掉 ✓ 行。
// 用 PATH 上的假 npm 驱动真实钩子文件:typecheck/lint/test 一律成功,gates:selftest 的输出和退出码由用例给定。
// 每个用例在本机所有可用的 POSIX sh(/bin/sh、dash、bash)上各跑一次:git 用 /bin/sh 执行钩子,Linux 上它是 dash。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const hook = path.join(root, ".githooks/pre-push");
const shells = ["/bin/sh", "/bin/dash", "/bin/bash", "/usr/bin/dash"].filter((s) => fs.existsSync(s));

function runHook(shell: string, selftestOut: string, selftestRc: number) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prepush-hook-"));
  try {
    fs.writeFileSync(
      path.join(dir, "npm"),
      '#!/bin/sh\ncase "$*" in *gates:selftest*) printf \'%s\' "$FAKE_SELFTEST_OUT"; exit "$FAKE_SELFTEST_RC";; esac\nexit 0\n',
      { mode: 0o755 },
    );
    const r = spawnSync(shell, [hook], {
      cwd: root,
      encoding: "utf8",
      timeout: 30_000,
      env: { PATH: `${dir}:/usr/bin:/bin`, FAKE_SELFTEST_OUT: selftestOut, FAKE_SELFTEST_RC: String(selftestRc) },
    });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

test("pre-push:自检失败一条时钩子拦下推送,输出仍滤掉对勾行", () => {
  assert.ok(shells.length > 0, "本机没有可用的 POSIX sh");
  for (const sh of shells) {
    const r = runHook(sh, "✓ G-A 合规样例通过\n✗ G-B 违规样例被放行\n自检失败 1/2\n", 1);
    assert.notEqual(r.status, 0, `${sh}:自检退出 1,钩子却放行了推送(stdout=${JSON.stringify(r.stdout)})`);
    assert.match(r.stdout, /✗ G-B 违规样例被放行/, `${sh}:失败行没有显示`);
    assert.doesNotMatch(r.stdout, /✓ G-A/, `${sh}:对勾行没有被滤掉`);
  }
});

test("pre-push:自检失败但输出只有对勾行时也拦下推送", () => {
  for (const sh of shells) {
    const r = runHook(sh, "✓ G-A 合规样例通过\n", 1);
    assert.notEqual(r.status, 0, `${sh}:自检退出 1,钩子却放行了推送`);
  }
});

test("pre-push:自检全过时钩子放行,只剩对勾行被滤掉也不算失败", () => {
  for (const sh of shells) {
    const all = runHook(sh, "✓ G-A 合规样例通过\n✓ G-B 违规样例被拦下\n", 0);
    assert.equal(all.status, 0, `${sh}:自检全过、输出全是对勾行,钩子却拦下了推送(stderr=${JSON.stringify(all.stderr)})`);
    assert.equal(all.stdout.includes("✓"), false, `${sh}:对勾行没有被滤掉`);
    const sum = runHook(sh, "✓ G-A 合规样例通过\n自检通过 1/1\n", 0);
    assert.equal(sum.status, 0, `${sh}:自检全过,钩子却拦下了推送`);
    assert.match(sum.stdout, /自检通过 1\/1/, `${sh}:非对勾行没有原样显示`);
  }
});

test("pre-push:钩子的退出码就是自检的退出码", () => {
  for (const sh of shells) {
    assert.equal(runHook(sh, "✗ G-C 自检崩溃\n", 3).status, 3, `${sh}:退出码没有原样传出`);
  }
});
