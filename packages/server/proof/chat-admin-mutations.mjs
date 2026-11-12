// 群管理与消息操作(U03/U23/U26/U100,D05)的行为变异校准(R-05 阳性埋雷):逐个注入单一故障,在隔离副本里跑相关测试文件;
// 每个变异都必须让至少一条原样副本里通过的具名测试失败(文件级加载失败不算),每处注入点必须恰好出现 1 次;原样副本必须全绿(阴性对照)。并发 1。
// 副本带整份 packages/,node_modules/@g-group/* 链到副本自己的包——跨包注入(领域)测的才是注入后的代码。
// 用法: node packages/server/proof/chat-admin-mutations.mjs
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const TESTS = [
  "packages/server/src/chat-admin.test.ts",
  "packages/domain/src/chat-admin.test.ts",
  "packages/domain/src/log.test.ts",
  "packages/server/src/chat-ops.test.ts",
  "packages/server/src/search.test.ts",
  "packages/server/src/members-lifecycle.test.ts",
];
const D = "packages/domain/src/log.ts";
const CA = "packages/server/src/chat-admin.ts";
const H = "packages/server/src/host.ts";
const S = "packages/server/src/search.ts";
/** [名字, [[文件, 原文, 改成]...]] */
const M = [
  // ---- 群主校验 ----
  ["C01 领域去掉群主校验:撤回别人的消息只看给没给群主身份,不比对发起人", [[D, "  const byOwner = body.kind === \"retract\" && owner !== null && sameSender(owner, sender);", "  const byOwner = body.kind === \"retract\" && owner !== null;"]]],
  ["C02 领域群主也能编辑别人的消息(群主权限不限于撤回)", [[D, "  const byOwner = body.kind === \"retract\" && owner !== null && sameSender(owner, sender);", "  const byOwner = owner !== null && sameSender(owner, sender);"]]],
  ["C03 宿主去掉群主校验:把当前用户当群主交给领域", [[H, "    const owner = room.kind === \"group\" && body.kind === \"retract\" ? this.chatAdmin.ownerOf(roomId) : null;", "    const owner = room.kind === \"group\" && body.kind === \"retract\" ? this.userId : null;"]]],
  ["C04 私聊也给群主撤回权", [[H, "    const owner = room.kind === \"group\" && body.kind === \"retract\" ? this.chatAdmin.ownerOf(roomId) : null;", "    const owner = body.kind === \"retract\" ? this.chatAdmin.ownerOf(roomId) : null;"]]],
  ["C05 群主判定恒真(谁都能解散、禁言)", [[CA, "    return this.ownerOf(roomId) === userId;", "    return true;"]]],
  ["C06 禁言不查群主也不拦私聊", [[H, "    this.ownerGroup(input.roomId, \"禁言\");", "    this.roomRow(input.roomId);"]]],
  // ---- 解散 ----
  ["X01 解散不先停在途任务", [[H, "        this.stopTask(t.id, this.userId);\n      } catch (e) {\n        this.report(\"dissolve-stop-failed\"", "        void t;\n      } catch (e) {\n        this.report(\"dissolve-stop-failed\""]]],
  ["X02 解散不等停止确认就算解散完(确认前就归还)", [[H, "    if (this.chatAdmin.dissolution(roomId) !== \"dissolving\" || this.liveTasksOfRoom(roomId).length) return;", "    if (this.chatAdmin.dissolution(roomId) !== \"dissolving\") return;"]]],
  ["X03 解散完不清零本群临时槽位", [[H, "      if (slots && slots.value.slots !== 0) putDoc(this.db, `room-slots:${roomId}`, slots.ver, { slots: 0 });\n", ""]]],
  ["X04 解散后用户仍能在群里发言", [[H, "    if ((sender.kind === \"user\" || sender.kind === \"helper\") && this.chatAdmin.isClosed(roomId)) throw new HostError(\"conflict\", DISSOLVED_REASON);\n", ""]]],
  ["X05 解散后联系人仍收到群消息", [[H, "    const rooms = this.roomsOfContact(contactId).filter((r) => !leavingRooms.has(r.id) && !this.chatAdmin.isClosed(r.id));", "    const rooms = this.roomsOfContact(contactId).filter((r) => !leavingRooms.has(r.id));"]]],
  ["X06 解散后仍能编辑消息", [[H, "    if (body.kind === \"edit\" && this.chatAdmin.isClosed(roomId)) throw new HostError(\"conflict\", DISSOLVED_REASON);\n", ""]]],
  ["X07 解散后仍能拉人", [[H, "    if (this.chatAdmin.isClosed(roomId)) throw new HostError(\"conflict\", DISSOLVED_REASON);\n    for (const m of members) if (m.kind === \"contact\") this.contactDoc(m.id);", "    for (const m of members) if (m.kind === \"contact\") this.contactDoc(m.id);"]]],
  ["X08 已解散/解散中不算只读(解散中的群里联系人照常发言)", [[CA, "    if (this.isClosed(roomId)) return DISSOLVED_REASON;\n", ""]]],
  // ---- 本端隐藏 ----
  ["H01 删除改成原地 UPDATE:隐藏时改写原消息的结构化记录", [[CA, "      run(this.db, \"INSERT INTO gg_view_hides (room_id, viewer_id, kind, seq, client_action_id, at) VALUES (?, ?, 'seq', ?, ?, ?)\", roomId, viewerId, seq, clientActionId, this.now());", "      run(this.db, \"INSERT INTO gg_view_hides (room_id, viewer_id, kind, seq, client_action_id, at) VALUES (?, ?, 'seq', ?, ?, ?)\", roomId, viewerId, seq, clientActionId, this.now());\n      run(this.db, \"UPDATE gg_msg SET client_action_id = ? WHERE room_id = ? AND seq = ?\", clientActionId, roomId, seq);"]]],
  ["H02 清空原地改写已有隐藏记录(去掉只追加触发器)", [
    [CA, "CREATE TRIGGER IF NOT EXISTS gg_view_hides_no_update BEFORE UPDATE ON gg_view_hides BEGIN SELECT RAISE(ABORT, 'view hides are append-only'); END;\nCREATE TRIGGER IF NOT EXISTS gg_view_hides_no_delete BEFORE DELETE ON gg_view_hides BEGIN SELECT RAISE(ABORT, 'view hides are append-only'); END;\n", ""],
    [CA, "    run(this.db, \"INSERT INTO gg_view_hides (room_id, viewer_id, kind, seq, client_action_id, at) VALUES (?, ?, 'clear', ?, ?, ?)\", roomId, viewerId, upto, clientActionId, this.now());", "    if (run(this.db, \"UPDATE gg_view_hides SET kind = 'clear', seq = ? WHERE room_id = ? AND viewer_id = ?\", upto, roomId, viewerId) === 0) run(this.db, \"INSERT INTO gg_view_hides (room_id, viewer_id, kind, seq, client_action_id, at) VALUES (?, ?, 'clear', ?, ?, ?)\", roomId, viewerId, upto, clientActionId, this.now());"],
  ]],
  ["H03 删除也从联系人上下文移除", [[H, "          if (!m || m.retracted) continue;", "          if (!m || m.retracted || this.chatAdmin.hidden(r.id, this.userId)(ev.seq)) continue;"]]],
  ["H04 消息列表不过滤本端隐藏", [[H, "    const msgs = this.projected(roomId).filter((m) => !hidden(m.seq));", "    const msgs = this.projected(roomId);"]]],
  ["H05 搜索不过滤本端隐藏", [[S, "  const where: string[] = [notHiddenSql(\"s\")];\n  const params: (string | number | null)[] = [userId, userId];", "  const where: string[] = [];\n  const params: (string | number | null)[] = [userId];"]]],
  ["H06 会话预览不过滤本端隐藏", [[H, "    const visible = msgs.filter((m) => !m.retracted && !hidden(m.seq));", "    const visible = msgs.filter((m) => !m.retracted);"]]],
  ["H07 清空把之后的新消息也藏起来(不按当时末尾)", [[CA, "    return (seq) => seq <= upto || seqs.has(seq);", "    return (seq) => upto > 0 || seqs.has(seq);"]]],
  ["H08 多选删除遇到不存在的 seq 整批报错", [[H, "    const exists = new Set(this.projected(input.roomId).map((m) => m.seq));\n", "    const exists = new Set(this.projected(input.roomId).map((m) => m.seq));\n    for (const s of input.seqs) if (!exists.has(s)) throw new HostError(\"not_found\", `没有 #${s}`);\n"]]],
  ["H09 清空重放不按 clientActionId 去重(再记一次、范围变了)", [[H, "    if (prior) return { room: this.roomView(input.roomId), clearedUptoSeq: (JSON.parse(prior.payload) as { upto: number }).upto };\n", ""]]],
  // ---- 禁言(候选) ----
  ["U01 禁言不拦 reply", [[H, "            const replyBlock = this.chatAdmin.speakBlock(a.roomId, contactId);\n            if (replyBlock) { reject(replyBlock); break; }\n", ""]]],
  ["U02 禁言状态不进发言判定", [[CA, "    if (this.isMuted(roomId, contactId)) return muteReason(this.titleOf(roomId));\n", ""]]],
  ["U03 禁言不拦交付", [[H, "            const deliverBlock = this.chatAdmin.speakBlock(t.roomId, contactId);\n            if (deliverBlock) { reject(deliverBlock); break; }\n", ""]]],
  ["U04 禁言顺手停掉它的任务", [[H, "    const changed = this.chatAdmin.setMuted(input.roomId, input.contactId, input.muted, this.userId);\n", "    const changed = this.chatAdmin.setMuted(input.roomId, input.contactId, input.muted, this.userId);\n    if (input.muted) for (const t of this.listTasks({ roomId: input.roomId, contactId: input.contactId })) if (t.state === \"T3_Running\") this.stopTask(t.id, this.userId);\n"]]],
  ["U05 不告诉被禁言的联系人", [[H, "      pointers: [...pointers, ...mem.pointers, ...this.chatAdmin.muteNotes(contactId)],", "      pointers: [...pointers, ...mem.pointers],"]]],
  ["U06 禁言时往群里发通知", [[H, "    if (changed) this.bus.emit({ type: \"room.updated\", room: view });\n", "    if (changed) this.postSystemNotice(input.roomId, \"有成员被禁言\", `mute:${input.clientActionId}`);\n"]]],
  // ---- system 发言者 ----
  ["S01 system 通知唤醒联系人", [[H, "    if (contextOnly(from) || this.chatAdmin.isClosed(roomId)) return;", "    if (this.chatAdmin.isClosed(roomId)) return;"]]],
  ["S02 system 通知进账本待处理", [[H, "        // system 通知只作上下文,不进账本的待处理\n        if (contextOnly(m.sender)) continue;\n", ""]]],
  ["S03 system 通知能作为接活来源", [[H, "            if (dispatchBlock) { reject(dispatchBlock); break; }\n            const src = freshMsgs.find((m) => m.roomId === a.roomId && m.seq === a.sourceSeq);\n            if (!src) { reject(`来源 ${a.roomId} #${a.sourceSeq} 不是本轮新消息`); break; }\n            if (contextOnly(src.sender)) { reject(CONTEXT_ONLY_REASON); break; }\n", "            if (dispatchBlock) { reject(dispatchBlock); break; }\n            const src = freshMsgs.find((m) => m.roomId === a.roomId && m.seq === a.sourceSeq);\n            if (!src) { reject(`来源 ${a.roomId} #${a.sourceSeq} 不是本轮新消息`); break; }\n"]]],
  ["S04 领域不把 system 当只作上下文", [[D, "  return sender.kind === \"system\";", "  return false;"]]],
  ["S05 领域不接受 system 发言者", [[D, "const SENDERS: ReadonlySet<string> = new Set<SenderKind>([\"user\", \"contact\", \"helper\", \"system\"]);", "const SENDERS: ReadonlySet<string> = new Set<SenderKind>([\"user\", \"contact\", \"helper\"]);"]]],
];

const TIMEOUT_MS = Number(process.env.MUT_TIMEOUT_MS ?? 300_000);
function run(dir) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--test", "--test-concurrency=1", "--test-timeout=120000", "--test-force-exit", "--test-reporter=tap", ...TESTS], { cwd: dir, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let timedOut = false;
    child.stdout.on("data", (d) => {
      out += d;
    });
    child.stderr.on("data", () => {});
    const kill = () => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        /* 已退出 */
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, TIMEOUT_MS);
    child.on("close", (code) => {
      clearTimeout(timer);
      kill();
      const failed = [...out.matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1]);
      const passed = [...out.matchAll(/^ok \d+ - (.+)$/gm)].map((m) => m[1]);
      resolve({ code, failed, passed, timedOut });
    });
  });
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "chat-admin-mut-"));
const pkgs = fs.readdirSync(path.join(ROOT, "packages"));
/** 副本:整份 packages/(不含 proof)+ node_modules(第三方链到原树,@g-group/* 链到副本自己的包) */
const copy = (name) => {
  const d = path.join(tmp, name);
  fs.cpSync(path.join(ROOT, "packages"), path.join(d, "packages"), { recursive: true, filter: (s) => !s.includes(`${path.sep}proof`) && !s.includes(`${path.sep}node_modules`) });
  for (const f of ["package.json", "tsconfig.json"]) fs.copyFileSync(path.join(ROOT, f), path.join(d, f));
  fs.mkdirSync(path.join(d, "node_modules", "@g-group"), { recursive: true });
  for (const e of fs.readdirSync(path.join(ROOT, "node_modules"))) {
    if (e === "@g-group" || e === ".bin" || e.startsWith(".")) continue;
    fs.symlinkSync(path.join(ROOT, "node_modules", e), path.join(d, "node_modules", e));
  }
  for (const p of pkgs) fs.symlinkSync(path.join("..", "..", "packages", p), path.join(d, "node_modules", "@g-group", p));
  return d;
};
const count = (s, sub) => s.split(sub).length - 1;

let ok = true;
console.log(`node ${process.version},变异 ${M.length} 个,测试文件 ${TESTS.length} 个`);
const clean = await run(copy("clean"));
const good = !clean.timedOut && clean.code === 0 && clean.failed.length === 0 && clean.passed.length > 0;
console.log(`${good ? "✓" : "✗"} 原样副本:${clean.passed.length} 绿 / ${clean.failed.length} 红${clean.failed.length ? `(${clean.failed.join(";")})` : ""}`);
if (!good) ok = false;
const named = new Set(clean.passed);
let killed = 0;
let survived = 0;
for (const [i, [name, edits]] of M.entries()) {
  const tag = `[${i + 1}/${M.length}]`;
  const d = copy(`m${i}`);
  let bad = null;
  for (const [file, from, to] of edits) {
    const f = path.join(d, file);
    const src = fs.readFileSync(f, "utf8");
    const n = count(src, from);
    if (n !== 1) {
      bad = `${file} 注入点出现 ${n} 次`;
      break;
    }
    fs.writeFileSync(f, src.replace(from, to));
  }
  if (bad) {
    ok = false;
    survived++;
    console.log(`✗ ${tag} ${name}:${bad},必须恰好 1 次`);
    fs.rmSync(d, { recursive: true, force: true });
    continue;
  }
  const t0 = Date.now();
  const r = await run(d);
  fs.rmSync(d, { recursive: true, force: true });
  const kills = r.failed.filter((t) => named.has(t));
  if (!r.timedOut && kills.length > 0) {
    killed++;
    console.log(`✓ ${tag} ${name}:${r.passed.length} 绿 / ${r.failed.length} 红,用时 ${((Date.now() - t0) / 1000).toFixed(1)}s,被发现:${kills.map((k) => `「${k}」`).join("")}`);
  } else {
    ok = false;
    survived++;
    console.log(`✗ ${tag} ${name}:${r.timedOut ? "超时" : `${r.passed.length} 绿 / ${r.failed.length} 红,存活(或只有文件级失败)`}`);
  }
}
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`合计 ${M.length}:杀死 ${killed},存活 ${survived}`);
console.log(ok ? "变异校准通过" : "变异校准失败");
process.exit(ok ? 0 : 1);
