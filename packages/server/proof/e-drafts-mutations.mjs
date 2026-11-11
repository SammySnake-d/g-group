// 手工变异(切片 feat/e-drafts):逐个把关键判据改坏,跑草稿相关具名测试,记录哪些测试按名失败;每次跑完还原源码。
// 按用户 dm#1128 本机只做开发,这份证据在云电脑 box4 上跑(输出第一行记运行环境)。
// 用法(仓库根目录):node packages/server/proof/e-drafts-mutations.mjs > packages/server/proof/e-drafts-mutations.txt
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import os from "node:os";

const TESTS = ["packages/api-contract/src/draft.test.ts", "packages/server/src/drafts.test.ts"];
const D = "packages/api-contract/src/draft.ts";
const H = "packages/server/src/host.ts";
const MUTANTS = [
  { id: "M1 引用不去重", file: D, from: "if (d.quotedSeqs.includes(op.seq)) return d;", to: "" },
  { id: "M2 删主回复连手打 @ 一起删", file: D, from: "replyAuthorId: null, mentions: withoutAuto(d.mentions, d.replyAuthorId) }", to: "replyAuthorId: null, mentions: d.mentions.filter((m) => m.id !== d.replyAuthorId) }" },
  { id: "M3 切换主回复残留旧 auto @", file: D, from: "const mentions = withoutAuto(d.mentions, d.replyAuthorId);", to: "const mentions = [...d.mentions];" },
  { id: "M4 回执不比版本、整份清空", file: D, from: "if (d.draftVer <= r.submittedVer) {", to: "if (true) {" },
  { id: "M5 迟到回执把新打的字也清掉", file: D, from: 'const text = s.text !== "" && d.text.startsWith(s.text) ? d.text.slice(s.text.length).replace(/^\\s+/, "") : d.text;', to: 'const text = "";' },
  { id: "M6 草稿 CAS 不比版本", file: H, from: "if (curVer !== expectedVer) throw", to: "if (false) throw" },
  { id: "M7 主回复不补进引用", file: H, from: "...(f.replyToSeq != null ? [f.replyToSeq] : [])", to: "" },
  { id: "M8 不带 draftVer 的发送也清草稿", file: H, from: "if (input.draftVer !== undefined) settled = this.settleDraftTx(room.id, { roomId: room.id, submittedVer: input.draftVer, submitted });", to: "settled = this.settleDraftTx(room.id, { roomId: room.id, submittedVer: input.draftVer ?? Number.MAX_SAFE_INTEGER, submitted });" },
  { id: "M9 保存草稿当成消息发出(进注意循环)", file: H, from: "    this.bus.emit({ type: \"draft.updated\", draft: saved });\n", to: "    this.bus.emit({ type: \"draft.updated\", draft: saved });\n    this.send({ roomId, clientActionId: `draft-${body.draftVer}`, text: body.text || \"草稿\" });\n" },
];

const failedNames = (tap) => [...tap.matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1].trim());
const run = () => spawnSync(process.execPath, ["--test", "--test-reporter=tap", "--test-concurrency=1", ...TESTS], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

console.log(`# 运行环境:${os.hostname()} ${process.platform}/${process.arch} node ${process.version}`);
const base = run();
console.log(`# 基线(未变异):退出码 ${base.status},失败 ${failedNames(base.stdout).length} 条`);
if (base.status !== 0) process.exit(1);
let killed = 0;
for (const m of MUTANTS) {
  const orig = readFileSync(m.file, "utf8");
  const count = orig.split(m.from).length - 1;
  if (count !== 1) {
    console.log(`\n## ${m.id}\n变异点在 ${m.file} 出现 ${count} 次,无法唯一定位,判为未执行`);
    continue;
  }
  writeFileSync(m.file, orig.replace(m.from, m.to));
  let r;
  try {
    r = run();
  } finally {
    writeFileSync(m.file, orig);
  }
  const names = failedNames(r.stdout);
  const dead = r.status !== 0 && names.length > 0;
  if (dead) killed++;
  console.log(`\n## ${m.id}\n文件:${m.file}\n改动:${JSON.stringify(m.from)} → ${JSON.stringify(m.to)}\n结果:${dead ? "被杀死" : "存活"}(退出码 ${r.status})`);
  for (const n of names) console.log(`  ✖ ${n}`);
}
console.log(`\n# 合计:${MUTANTS.length} 个变异,杀死 ${killed},存活 ${MUTANTS.length - killed}`);
process.exit(killed === MUTANTS.length ? 0 : 1);
