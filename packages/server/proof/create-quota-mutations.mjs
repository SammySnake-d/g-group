// 一次一个单点变异。原样全绿、具名 AssertionError 才算杀死;超时/加载失败不算。
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const source = process.cwd();
const tmp = mkdtempSync(path.join(os.tmpdir(), "gg-create-quota-mut-"));
const H = "packages/server/src/host.ts";
const A = "packages/api-contract/src/api.ts";
const S = "packages/server/src/service.ts";
const test = "packages/server/src/create-quota.test.ts";
const edit = (file, from, to) => ({ file, from, to });
const mutants = [
  ["M01", "CQ01", [edit(A, "      computeSlots: opt(PersonalComputeSlots),\n      /** 预检发现", "      /** 预检发现")]],
  ["M02", "CQ01", [edit(H, "computeSlots: input.computeSlots ?? null,", "computeSlots: null,")]],
  ["M03", "CQ02", [edit(A, "members: arr(MemberRef, { max: 100 }), tempComputeSlots: opt(GroupComputeSlots) }), RoomView),", "members: arr(MemberRef, { max: 100 }) }), RoomView),")]],
  ["M04", "CQ02", [edit(S, "host.createGroup(p.title, p.members, p)", "host.createGroup(p.title, p.members)")]],
  ["M05", "CQ02", [edit(H, "{ slots: options.tempComputeSlots ?? 0 }", "{ slots: 0 }")]],
  ["M06", "CQ03", [edit(A, "const PersonalComputeSlots = nullable(int({ min: 1, max: 64 }));", "const PersonalComputeSlots = nullable(int({ min: 0, max: 65 }));")]],
  ["M07", "CQ04", [edit(A, "const GroupComputeSlots = int({ min: 0, max: 64 });", "const GroupComputeSlots = int({ min: -1, max: 65 });")]],
  ["M08", "CQ05", [edit(H, "computeSlots: input.computeSlots ?? null,", "computeSlots: input.computeSlots ?? 1,")]],
  ["M09", "CQ06", [edit(H, "      putDoc(this.db, `room-slots:${id}`, 0, { slots: options.tempComputeSlots ?? 0 });", "      if ((options.tempComputeSlots ?? 0) > 0) putDoc(this.db, `room-slots:${id}`, 0, { slots: options.tempComputeSlots ?? 0 });")]],
  ["M10", "CQ07", [edit(H, "      if (prior) {\n        const saved = JSON.parse(prior.payload) as { request: unknown; result: T };", "      if (prior && kind !== \"contact\") {\n        const saved = JSON.parse(prior.payload) as { request: unknown; result: T };")]],
  ["M11", "CQ08", [edit(H, "      if (prior) {\n        const saved = JSON.parse(prior.payload) as { request: unknown; result: T };", "      if (prior && kind !== \"group\") {\n        const saved = JSON.parse(prior.payload) as { request: unknown; result: T };")]],
  ["M12", "CQ09", [edit(H, "`create:${kind}:${clientActionId}`", "`create:${clientActionId}`")]],
  ["M13", "CQ10", [edit(H, "    return tx(this.db, () => {\n      const key = clientActionId", "    return (() => {\n      const key = clientActionId"), edit(H, "      return { view, replay: false };\n    });\n  }\n  createContact", "      return { view, replay: false };\n    })();\n  }\n  createContact")]],
  ["M14", "CQ07", [edit(H, "if (!isDeepStrictEqual(saved.request, normalized))", "if (kind !== \"contact\" && !isDeepStrictEqual(saved.request, normalized))")]],
  ["M15", "CQ08", [edit(H, "if (!isDeepStrictEqual(saved.request, normalized))", "if (kind !== \"group\" && !isDeepStrictEqual(saved.request, normalized))")]],
  ["M16", "CQ12", [edit(H, "personal: (contactId) => getDoc<ContactDoc>(this.db, `contact:${contactId}`)?.value.computeSlots ?? opts.personalComputeSlots ?? Number.POSITIVE_INFINITY,", "personal: () => Number.POSITIVE_INFINITY,")]],
  ["M17", "CQ13", [edit(H, "    const { confirmAffected, clientActionId, expectedVersion, ...patch } = input;", "    const { confirmAffected, clientActionId, expectedVersion, ...patch } = input;\n    if (patch.computeSlots !== undefined) for (const held of this.quota.view().leases) this.quota.release(held.leaseId);")]],
];
function execute() {
  const r = spawnSync(process.execPath, ["--test", "--test-concurrency=1", "--test-reporter=tap", test], { cwd: tmp, encoding: "utf8", timeout: 60_000, maxBuffer: 12 * 1024 * 1024 });
  const text = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const failed = [...text.matchAll(/^not ok \d+ - (.+)\n([\s\S]*?)(?=^# Subtest:|^1\.\.)/gm)].map((m) => ({ name: m[1], assertion: /code: 'ERR_ASSERTION'/.test(m[2]) }));
  return { status: r.status, signal: r.signal, error: r.error?.message ?? null, total: Number(text.match(/^# tests (\d+)$/m)?.[1] ?? 0), pass: Number(text.match(/^# pass (\d+)$/m)?.[1] ?? 0), failed, text };
}
const registered = JSON.parse(readFileSync(path.join(source, "packages/server/proof/create-quota-mutations-plan.json"), "utf8"));
if (JSON.stringify(registered.mutants.map((x) => [x.id, x.expected_test])) !== JSON.stringify(mutants.map(([id, test]) => [id, test]))) throw new Error("变异清单不等于预登记");
try {
  for (const dir of ["packages", "third_party"]) if (existsSync(path.join(source, dir))) cpSync(path.join(source, dir), path.join(tmp, dir), { recursive: true });
  cpSync(path.join(source, "package.json"), path.join(tmp, "package.json"));
  // 第三方依赖只读复用；工作区包必须落到本变异副本，不能沿绝对链接回到绿色原树。
  mkdirSync(path.join(tmp, "node_modules", "@g-group"), { recursive: true });
  for (const name of readdirSync(path.join(source, "node_modules"))) {
    if (name === "@g-group" || name === ".bin" || name.startsWith(".")) continue;
    symlinkSync(realpathSync(path.join(source, "node_modules", name)), path.join(tmp, "node_modules", name));
  }
  for (const name of readdirSync(path.join(tmp, "packages"))) {
    const file = path.join(tmp, "packages", name, "package.json");
    if (!existsSync(file)) continue;
    const pkg = JSON.parse(readFileSync(file, "utf8"));
    if (!pkg.name?.startsWith("@g-group/")) continue;
    const link = path.join(tmp, "node_modules", pkg.name);
    symlinkSync(path.join("..", "..", "packages", name), link);
    if (realpathSync(link) !== realpathSync(path.join(tmp, "packages", name))) throw new Error(`工作区依赖未指向变异副本:${pkg.name}`);
  }
  const logDir = path.join(source, "packages/server/proof/create-quota-mutation-logs");
  mkdirSync(logDir, { recursive: true });
  const baseline = execute();
  writeFileSync(path.join(logDir, "baseline.tap"), baseline.text);
  console.log(JSON.stringify({ baseline: { status: baseline.status, total: baseline.total, pass: baseline.pass, failed: baseline.failed, error: baseline.error } }));
  if (baseline.status !== 0 || baseline.total !== 13 || baseline.pass !== 13) throw new Error("原样对照不是 13/13,不评变异");
  const originals = new Map([H, A, S].map((file) => [file, readFileSync(path.join(tmp, file), "utf8")]));
  const results = [];
  for (const [name, criterion, edits] of mutants) {
    for (const [file, text] of originals) writeFileSync(path.join(tmp, file), text);
    for (const { file, from, to } of edits) {
      const p = path.join(tmp, file); const text = readFileSync(p, "utf8");
      if (text.split(from).length !== 2) throw new Error(`变异锚点不是唯一:${name}:${from}`);
      writeFileSync(p, text.replace(from, to));
    }
    const r = execute();
    writeFileSync(path.join(logDir, `${name.split(" ")[0]}.tap`), r.text);
    const killed = r.status === 1 && r.total === 13 && r.error === null && r.failed.some((x) => x.name.startsWith(criterion) && x.assertion);
    const result = { name, criterion, killed, status: r.status, total: r.total, failures: r.failed, other_criteria_failures: r.failed.filter((x) => !x.name.startsWith(criterion)), error: r.error };
    results.push(result); console.log(JSON.stringify(result));
  }
  const summary = { mutants: results.length, killed: results.filter((x) => x.killed).length, survivedOrInvalid: results.filter((x) => !x.killed).length, baseline: { total: 13, pass: 13 }, results };
  writeFileSync(path.join(source, "packages/server/proof/create-quota-mutations.json"), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify({ mutants: summary.mutants, killed: summary.killed, survivedOrInvalid: summary.survivedOrInvalid }));
  process.exitCode = summary.survivedOrInvalid ? 1 : 0;
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
