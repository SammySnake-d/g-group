// 真实服务调用(切片 feat/e-drafts):真 SQLite 文件 + 真 Host + createService(和 Electron 主进程 bindIpc 同一入口),
// 按 AC-37 ② / AC-24 走一遍:存群草稿与私聊草稿 → 关宿主重启 → 取回;旧版本写入冲突;点发送后继续打字、迟到回执只清已发部分。
// 联系人脑子换成「被调用就记一笔」的探针:草稿路径不该唤醒任何联系人。
// 用法(仓库根目录):node packages/server/proof/e-drafts-service.mjs > packages/server/proof/e-drafts-service.txt
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Host } from "../src/host.ts";
import { createService } from "../src/service.ts";

const dir = mkdtempSync(path.join(tmpdir(), "gg-drafts-proof-"));
const file = path.join(dir, "gg.db");
let rounds = 0;
const mind = () => ({ async round() { rounds++; return { actions: [], stateNote: null }; } });
const show = (label, r) => console.log(`${label}\n${JSON.stringify(r.ok ? r.value : r.error, (k, v) => (k === "updatedAt" || k === "at" ? "<时间>" : v))}\n`);
try {
  let host = new Host({ file, mind, maxDeferMs: 5 });
  let svc = createService(host);
  const claude = host.createContact({ name: "Claude Code" });
  const argon = host.createContact({ name: "Argon" });
  const g = host.createGroup("登录模块", [{ kind: "contact", id: claude.id }, { kind: "contact", id: argon.id }]);
  const dm = host.openDm(argon.id);
  for (const t of ["方案 A", "方案 B", "方案 C"]) host.send({ roomId: g.id, clientActionId: `seed-${t}`, text: t });
  await host.idle();
  const roundsBefore = rounds;
  show("1) drafts.save 群草稿(回复 #1 + 引用 #2 #3,auto @Claude Code,手打 @Argon):", await svc.handle("drafts.save", { roomId: g.id, expectedVer: 0, draft: { text: "关于登录模块,我认为还要加上", replyToSeq: 1, replyAuthorId: claude.id, quotedSeqs: [1, 2, 3], mentions: [{ id: claude.id, source: "auto" }, { id: argon.id, source: "manual" }], draftVer: 6 } }));
  show("2) drafts.save 私聊草稿:", await svc.handle("drafts.save", { roomId: dm.id, expectedVer: 0, draft: { text: "私聊里回一句", replyToSeq: null, replyAuthorId: null, quotedSeqs: [], mentions: [], draftVer: 1 } }));
  show("3) 另一个窗口拿旧版本写(expectedVer 0):", await svc.handle("drafts.save", { roomId: g.id, expectedVer: 0, draft: { text: "侧边栏", replyToSeq: null, replyAuthorId: null, quotedSeqs: [], mentions: [], draftVer: 1 } }));
  await host.idle();
  console.log(`草稿操作期间联系人轮次增量:${rounds - roundsBefore};群日志末尾 seq:${host.lastSeq(g.id)}\n`);
  await host.close();

  host = new Host({ file, mind, maxDeferMs: 5 });
  svc = createService(host);
  show("4) 重启宿主后 drafts.get 群草稿:", await svc.handle("drafts.get", { roomId: g.id }));
  show("5) 重启后 drafts.get 私聊草稿:", await svc.handle("drafts.get", { roomId: dm.id }));
  const rooms = await svc.handle("rooms.list", {});
  console.log(`6) rooms.list 的草稿提示:${JSON.stringify(rooms.value.rooms.map((r) => [r.title, r.draftPreview ?? "(无字段)"]))}\n`);
  show("7) 点发送(draftVer 6)前,用户已继续打字并存了 v7:", await svc.handle("drafts.save", { roomId: g.id, expectedVer: 6, draft: { text: "关于登录模块,我认为还要加上\n限流阈值", replyToSeq: 1, replyAuthorId: claude.id, quotedSeqs: [1, 2, 3], mentions: [{ id: claude.id, source: "auto" }, { id: argon.id, source: "manual" }], draftVer: 7 } }));
  const sent = await svc.handle("messages.send", { roomId: g.id, clientActionId: "send-v6", text: "关于登录模块,我认为还要加上", replyToSeq: 1, quotedSeqs: [1, 2, 3], mentions: [{ id: claude.id, source: "auto" }, { id: argon.id, source: "manual" }], draftVer: 6 });
  console.log(`8) messages.send(draftVer 6)落盘:${JSON.stringify(sent.ok ? { seq: sent.value.seq, replyToSeq: sent.value.replyToSeq, quotedSeqs: sent.value.quotedSeqs, mentions: sent.value.mentions } : sent.error)}\n`);
  show("9) 迟到回执后的草稿(只去掉已发部分,v7 新打的「限流阈值」保留):", await svc.handle("drafts.get", { roomId: g.id }));
  await host.idle();
  await host.close();
} finally {
  rmSync(dir, { recursive: true, force: true });
}
