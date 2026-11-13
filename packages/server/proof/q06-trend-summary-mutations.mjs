// Q06-2 群聊动向摘要(U80,D21.4 第 2、4 步:固定区间只读桥、来源校验、撤回失效、本端删除分域、重做、读取)的行为变异校准(R-05 阳性埋雷):
// 逐个注入单一故障,在隔离副本里跑相关测试文件;每个变异点名一条必须发现它的具名测试——这条没按名字失败就算存活(别的测试红了不算);
// 每处注入点必须恰好出现 1 次;原样副本必须全绿(阴性对照)。并发 1。副本带整份 packages/,node_modules/@g-group/* 链到副本自己的包。
// 用法: node packages/server/proof/q06-trend-summary-mutations.mjs   (MUT_ONLY=V01,W03 只跑点名的几个;MUT_DRY=1 只核对注入点)
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const TAG = "q06-ts-mut";
const TESTS = ["packages/server/src/trend-summaries.test.ts", "packages/server/src/trend-summary-format.test.ts", "packages/server/src/count-triggers.test.ts"];
const S = "packages/server/src/trend-summaries.ts";
const F = "packages/server/src/trend-summary-format.ts";
const H = "packages/server/src/host.ts";
const AS = "packages/server/src/assemble.ts";
/** [名字, [[文件, 原文, 改成]...], 必须发现它的那条测试(标题开头)] */
const M = [
  ["V01 撤回事务里不让摘要过期", [[H, "        if (body.kind === \"retract\") this.summaries.invalidateTx(roomId, body.target);\n", ""]], "撤回后摘要对所有人过期"],
  ["V02 过期不清正文(撤回的原文留在旧摘要里)", [[S, "SET status = 'stale', items = '[]', stale_reason", "SET status = 'stale', stale_reason"]], "撤回后摘要对所有人过期"],
  ["V03 区间左端也算(撤回起点那条,下一段也过期)", [[S, "r.from_seq < seq && seq <= r.to_seq", "r.from_seq <= seq && seq <= r.to_seq"]], "撤回后摘要对所有人过期"],
  ["V04 区间右端不算(撤回一段的最后一条不过期)", [[S, "r.from_seq < seq && seq <= r.to_seq", "r.from_seq < seq && seq < r.to_seq"]], "撤回后摘要对所有人过期"],
  ["V05 不看区间(本会话任何撤回都让所有摘要过期)", [[S, "      .filter((r) => covers(r, seq))\n", ""]], "撤回后摘要对所有人过期"],
  ["V06 不限本会话(别的群里 seq 撞上的摘要也过期)", [[S, "\"SELECT * FROM gg_summaries WHERE room_id = ? AND status = 'ok' ORDER BY to_seq, id\", roomId)", "\"SELECT * FROM gg_summaries WHERE status = 'ok' ORDER BY to_seq, id\")"]], "撤回后摘要对所有人过期"],
  ["V07 没生成成的摘要也被撤回改成过期", [[S, "WHERE room_id = ? AND status = 'ok' ORDER BY to_seq, id\", roomId)", "WHERE room_id = ? AND status IN ('ok', 'failed') ORDER BY to_seq, id\", roomId)"]], "模型没成不重试"],
  ["V08 已过期的摘要被后来的撤回改写原因", [[S, "WHERE room_id = ? AND status = 'ok' ORDER BY to_seq, id\", roomId)", "WHERE room_id = ? AND status IN ('ok', 'stale') ORDER BY to_seq, id\", roomId)"]], "生成途中撤回"],
  ["V09 撤回后不推过期事件", [[H, "      this.summaries.announce();\n    } catch (e) {", "    } catch (e) {"]], "撤回后摘要对所有人过期"],
  ["V10 过期不记是哪条 seq", [[S, "WHERE id = ?\", seq, this.d.now(), id);", "WHERE id = ?\", null, this.d.now(), id);"]], "撤回后摘要对所有人过期"],
  ["W01 落库前不复核(途中撤回的原文落进正文)", [[S, "const gone = retractedSeqs(this.d.db, r.room_id).find((q) => covers(r, q) && !retractedBefore.has(q));", "const gone = undefined as number | undefined;"]], "生成途中撤回"],
  ["W02 复核把生成前就撤回的也算(重做出来的新版本直接过期)", [[S, ".find((q) => covers(r, q) && !retractedBefore.has(q));", ".find((q) => covers(r, q));"]], "过期后可重做"],
  ["W03 复核不看区间(途中撤回区间外的消息也过期)", [[S, ".find((q) => covers(r, q) && !retractedBefore.has(q));", ".find((q) => !retractedBefore.has(q));"]], "生成途中撤回"],
  ["W04 途中撤回落成过期但不结清窗口", [[S, "      this.d.settleWindowTx(r.trigger_id, r.to_seq, \"done\");\n", ""]], "生成途中撤回"],
  ["W05 生成落成后不推 summary.updated", [[S, "    this.dirty.add(id);\n    this.announce();\n  }", "    this.dirty.add(id);\n  }"]], "到点只调一次联系人模型"],
  ["G01 到点不交给摘要", [[H, "        this.summaries.enqueue(w);\n", ""]], "到点只调一次联系人模型"],
  ["G02 空区间不记 empty", [[S, "    if (lines.length === 0) return this.finish(r, { status: \"empty\" });\n", ""]], "没有可总结的发言不调模型"],
  ["G03 读区间时不按提出人本端的删除过滤", [[S, "uptoSeq: r.to_seq, hidden: this.d.hidden(r.room_id, r.requester_id) });", "uptoSeq: r.to_seq });"]], "没有可总结的发言不调模型"],
  ["G04 读区间不设右端(读到会话末尾)", [[S, "afterSeq: r.from_seq, uptoSeq: r.to_seq, hidden", "afterSeq: r.from_seq, hidden"]], "撤回后摘要对所有人过期"],
  ["G05 读区间左端取 0(从会话开头读)", [[S, "afterSeq: r.from_seq, uptoSeq: r.to_seq, hidden", "afterSeq: 0, uptoSeq: r.to_seq, hidden"]], "到点只调一次联系人模型"],
  ["G06 不按输入上限截", [[S, "const covered = fitLines(lines, this.d.inputMaxBytes ?? SUMMARY_INPUT_MAX_BYTES);", "const covered = lines;"]], "整段读全不设条数上限"],
  ["G07 截断了不标 truncated", [[S, "      covered.length < messageCount ? 1 : 0,\n", "      0,\n"]], "整段读全不设条数上限"],
  ["G08 来源认整段区间(没读到的消息也能当来源)", [[S, "new Set(covered.map((l) => l.seq)));", "new Set(lines.map((l) => l.seq)));"]], "整段读全不设条数上限"],
  ["G09 不校验来源在不在读到的消息里", [[F, "    if (bad !== undefined) return { ok: false, reason: `来源 #${bad} 不在这次读到的消息里` };\n", ""]], "来源必须在本房、本区间、生成时可见"],
  ["G10 别的会话里的 reply 也当要点收", [[S, "const parsed = parseSummary(out.actions.flatMap((a) => (a.kind === \"reply\" && a.roomId === r.room_id ? [a.text] : []))", "const parsed = parseSummary(out.actions.flatMap((a) => (a.kind === \"reply\" ? [a.text] : []))"]], "摘要只读"],
  ["G11 生成完不结清窗口(重启后同一段再调一次)", [[S, "    this.d.settleWindowTx(r.trigger_id, r.to_seq, set.status === \"failed\" ? \"failed\" : \"done\");\n", ""]], "到点只调一次联系人模型"],
  ["G12 没生成成的窗口记成 done", [[S, "this.d.settleWindowTx(r.trigger_id, r.to_seq, set.status === \"failed\" ? \"failed\" : \"done\");", "this.d.settleWindowTx(r.trigger_id, r.to_seq, \"done\");"]], "模型没成不重试"],
  ["G13 已取消的窗口照样生成", [[S, "      if (!this.d.windowPending(w.triggerId, w.toSeqInclusive)) return null;\n", ""]], "撤销承诺后还没生成的那一段不再调模型"],
  ["G14 联系人不在这个会话也照调模型", [[S, "const blocked = who ? this.d.blockedWhy(r.contact_id, r.room_id) : \"联系人已删除\";", "const blocked = who ? null : \"联系人已删除\";"]], "到点时联系人已不在这个会话或已被删除"],
  ["G15 已删除的联系人也拿来做摘要", [[H, "        return c && !c.removed ? { profile: { id: c.id, name: c.name, speakingModel: c.speakingModel, persona: c.persona }, mind: this.opts.mind(this.contactView(c)) } : null;", "        return c ? { profile: { id: c.id, name: c.name, speakingModel: c.speakingModel, persona: c.persona }, mind: this.opts.mind(this.contactView(c)) } : null;"]], "到点时联系人已不在这个会话或已被删除"],
  ["G16 messageCount 记成读到的条数", [[S, "return this.finishTx(r, { status: \"ok\", items: parsed.items, messageCount: lines.length, covered });", "return this.finishTx(r, { status: \"ok\", items: parsed.items, messageCount: covered.length, covered });"]], "整段读全不设条数上限"],
  ["G17 模型多余的动作不留记录", [[S, "if (ignored.length || out.stateNote !== null) this.d.report(", "if (!this.d.db) this.d.report("]], "摘要只读"],
  ["G18 记录里的模型不是联系人的说话模型", [[S, "JSON.stringify({ speakingModel: i.model }),", "JSON.stringify({ speakingModel: \"\" }),"]], "到点只调一次联系人模型"],
  ["G19 新建和落成都不推 summary.updated", [[H, "changed: (summaryId) => this.bus.emit({ type: \"summary.updated\", summary: this.summaries.view(summaryId, this.userId) }),", "changed: () => {},"]], "到点只调一次联系人模型"],
  ["G20 宿主不把输入上限交给摘要", [[H, "      ...(opts.summaryInputMaxBytes !== undefined ? { inputMaxBytes: opts.summaryInputMaxBytes } : {}),\n", ""]], "整段读全不设条数上限"],
  ["G21 承诺原文不给模型", [[S, "commitmentText: this.d.commitmentText(r.commitment_id, r.contact_id, r.room_id),", "commitmentText: null,"]], "到点只调一次联系人模型"],
  ["G22 平常轮的账本里不写「到点由宿主交给你」那句", [[H, "status: c.status, ...(every !== undefined ? { shortName: summaryLedgerNote(every) } : {}) });", "status: c.status });"]], "平常轮的承诺账本写明这条承诺到点由宿主另起一轮交给它"],
  ["G23 账本那句说明没传到给模型的账本块里", [[AS, "...(l.shortName !== undefined ? { shortName: l.shortName } : {}) })),", "})),"]], "平常轮的承诺账本写明这条承诺到点由宿主另起一轮交给它"],
  ["E01 超时原因写不出来(记成已中止)", [[S, "          reject(new Error(\"等模型超时\"));\n          ac.abort();", "          ac.abort();"]], "模型没成不重试"],
  ["E02 超时不中止在途的模型调用", [[S, "          reject(new Error(\"等模型超时\"));\n          ac.abort();", "          reject(new Error(\"等模型超时\"));"]], "模型没成不重试"],
  ["E03 启动时不收拾被打断的摘要(一直 generating)", [[H, "    tx(this.db, () => this.summaries.recoverTx());\n", ""]], "模型没成不重试"],
  ["E04 宿主关闭时把在途的记成模型失败(重启后看不出是被打断)", [[S, "      if (this.closed) return;\n      return this.finish(r, { status: \"failed\", messageCount: lines.length, covered, error: `模型调用没成:${errorText(e)}` });", "      return this.finish(r, { status: \"failed\", messageCount: lines.length, covered, error: `模型调用没成:${errorText(e)}` });"]], "模型没成不重试"],
  ["E05 宿主关闭后排着队的窗口照样开跑", [[S, "  private async runWindow(w: CountWindow): Promise<void> {\n    if (this.closed) return;\n", "  private async runWindow(w: CountWindow): Promise<void> {\n"]], "模型没成不重试"],
  ["E06 解析不出要点也落成 ok", [[S, "    if (!parsed.ok) return this.finish(r, { status: \"failed\", messageCount: lines.length, covered, error: parsed.reason });\n", "    if (!parsed.ok) return this.finish(r, { status: \"ok\", items: [], messageCount: lines.length, covered });\n"]], "来源必须在本房、本区间、生成时可见"],
  ["D01 还有效的摘要也能重做", [[S, "    if (old.status !== \"stale\" && old.status !== \"failed\") throw new HostError(\"conflict\", `这份摘要是 ${old.status},只有已过期或没生成成的才能重做`);\n", ""]], "过期后可重做"],
  ["D02 已有新版本的旧摘要还能再重做", [[S, "    if (one(this.d.db, \"SELECT 1 FROM gg_summaries WHERE supersedes = ?\", old.id)) throw new HostError(\"conflict\", \"这份摘要已经有更新的版本\");\n", ""]], "过期后可重做"],
  ["D03 重做不幂等(同一 clientActionId 再出一版)", [[S, "    if (prior) return this.view(", "    if (prior && !this.d.db) return this.view("]], "过期后可重做"],
  ["D04 新版本不指回旧版本", [[S, "triggerId: old.trigger_id, from: old.from_seq, to: old.to_seq, supersedes: old.id,", "triggerId: old.trigger_id, from: old.from_seq, to: old.to_seq, supersedes: null,"]], "过期后可重做"],
  ["D05 联系人不在这个会话也放行重做", [[S, "const blocked = who ? this.d.blockedWhy(old.contact_id, old.room_id) : \"联系人已删除\";", "const blocked = who ? null : \"联系人已删除\";"]], "过期后可重做"],
  ["D06 版本号不是接着上一版", [[S, "i.roomId, i.contactId, i.from, i.to)?.v ?? 0) + 1;", "i.roomId, i.contactId, i.from, i.to)?.v ?? 0) + 2;"]], "过期后可重做"],
  ["D08 重做只建记录不调模型", [[S, "    this.push(() => this.generate(id));\n", ""]], "过期后可重做"],
  ["P01 视图不按本端删除过滤要点", [[S, "const items = all_.filter((it) => it.hiddenSourceSeqs.length < it.sourceSeqs.length);", "const items = all_;"]], "本端删除只影响那位用户的视图"],
  ["P02 有一个来源被删就整条不给看", [[S, "it.hiddenSourceSeqs.length < it.sourceSeqs.length);", "it.hiddenSourceSeqs.length === 0);"]], "本端删除只影响那位用户的视图"],
  ["P03 按提出人的隐藏过滤所有人的视图", [[S, "const hidden = this.d.hidden(r.room_id, viewerId);", "const hidden = this.d.hidden(r.room_id, r.requester_id);"]], "本端删除只影响那位用户的视图"],
  ["P04 被删掉的要点条数不报", [[S, "hiddenItems: all_.length - items.length,", "hiddenItems: 0,"]], "本端删除只影响那位用户的视图"],
  ["P05 不标哪些来源在本端已删", [[S, "hiddenSourceSeqs: it.sourceSeqs.filter((q) => hidden(q)) }));", "hiddenSourceSeqs: it.sourceSeqs.filter((q) => hidden(q) && false) }));"], [S, "const items = all_.filter((it) => it.hiddenSourceSeqs.length < it.sourceSeqs.length);", "const items = all_.filter((it) => it.sourceSeqs.some((q) => !hidden(q)));"]], "本端删除只影响那位用户的视图"],
  ["P06 本端删除也让摘要记录过期", [[H, "      this.chatAdmin.hide(input.roomId, this.userId, seqs, input.clientActionId);\n", "      this.chatAdmin.hide(input.roomId, this.userId, seqs, input.clientActionId);\n      for (const q of seqs) this.summaries.invalidateTx(input.roomId, q);\n"]], "本端删除只影响那位用户的视图"],
  ["P07 supersededBy 查不出来", [[S, "\"SELECT id FROM gg_summaries WHERE supersedes = ?\", r.id)?.id ?? null,", "\"SELECT id FROM gg_summaries WHERE supersedes = ? AND 0\", r.id)?.id ?? null,"]], "过期后可重做"],
  ["P08 时间轴默认把旧版本也列出来", [[S, "n.supersedes = s.id)\"}", "n.supersedes = s.id AND 0)\"}"]], "过期后可重做"],
  ["P09 includeSuperseded 不起作用", [[S, "${q.includeSuperseded ? \"\" : \" AND NOT EXISTS", "${!q.roomId ? \"\" : \" AND NOT EXISTS"]], "过期后可重做"],
  ["P10 时间轴顺序反了(从旧到新)", [[S, "ORDER BY s.to_seq DESC, s.contact_id", "ORDER BY s.to_seq ASC, s.contact_id"]], "时间轴读取"],
  ["P11 翻页边界含 beforeToSeq 那一段", [[S, "WHERE s.room_id = ? AND s.to_seq < ?$", "WHERE s.room_id = ? AND s.to_seq <= ?$"]], "时间轴读取"],
  ["P12 hasMore 恒为假", [[S, "hasMore: rows.length > limit };", "hasMore: false };"]], "时间轴读取"],
  ["P13 limit 不生效", [[S, "summaries: rows.slice(0, limit).map(", "summaries: rows.map("]], "时间轴读取"],
  ["P14 时间轴把别的会话的摘要也列出来", [[S, "FROM gg_summaries s WHERE s.room_id = ? AND s.to_seq < ?$", "FROM gg_summaries s WHERE ? IS NOT NULL AND s.to_seq < ?$"]], "撤回后摘要对所有人过期"],
  ["P15 不在这个会话的用户能列摘要", [[H, "    this.userRoom(q.roomId);\n    return this.summaries.list({ ...q, viewerId: this.userId });", "    return this.summaries.list({ ...q, viewerId: this.userId });"]], "撤销承诺后还没生成的那一段不再调模型"],
  ["P16 不在这个会话的用户能读单份摘要", [[H, "    this.userRoom(v.roomId);\n    return v;", "    return v;"]], "撤销承诺后还没生成的那一段不再调模型"],
  ["P17 不在这个会话的用户能重做摘要", [[H, "    this.getSummary(input.summaryId);\n", ""]], "撤销承诺后还没生成的那一段不再调模型"],
  ["F01 截取不算每条的记账字节", [[F, "return Buffer.byteLength(text, \"utf8\") + 64;", "return Buffer.byteLength(text, \"utf8\");"]], "按字节预算截取连续前缀"],
  ["F02 按字符数而不是字节数截", [[F, "return Buffer.byteLength(text, \"utf8\") + 64;", "return text.length + 64;"]], "按字节预算截取连续前缀"],
  ["F03 正好到预算的那条不收", [[F, "    if (used > maxBytes) break;", "    if (used >= maxBytes) break;"]], "按字节预算截取连续前缀"],
  ["F04 要点正好 30 条被拒", [[F, "if (items.length > SUMMARY_MAX_ITEMS) return", "if (items.length >= SUMMARY_MAX_ITEMS) return"]], "上限"],
  ["F05 要点不设条数上限", [[F, "  if (items.length > SUMMARY_MAX_ITEMS) return { ok: false, reason: `要点超过 ${SUMMARY_MAX_ITEMS} 条` };\n", ""]], "上限"],
  ["F06 要点不设字数上限", [[F, "    if (text.length > SUMMARY_MAX_ITEM_CHARS) return { ok: false, reason: `有要点超过 ${SUMMARY_MAX_ITEM_CHARS} 字` };\n", ""]], "上限"],
  ["F07 一条要点的来源不设上限", [[F, "    if (seqs.length > SUMMARY_MAX_SOURCES) return { ok: false, reason: `一条要点的来源超过 ${SUMMARY_MAX_SOURCES} 个` };\n", ""]], "上限"],
  ["F08 没带来源的要点悄悄丢掉,其余照收", [[F, "    if (!s) return { ok: false, reason: `有要点没带来源:${body.slice(0, 80)}` };", "    if (!s) continue;"]], "不合格整份不要并说明原因"],
  ["F09 只有来源没有内容的要点也收", [[F, "    if (!text) return { ok: false, reason: \"有要点只有来源没有内容\" };\n", ""]], "不合格整份不要并说明原因"],
  ["F10 一条要点都没有也算成功", [[F, "  if (items.length === 0) return { ok: false, reason: \"没有给出带来源的要点\" };\n", ""]], "不合格整份不要并说明原因"],
  ["F11 来源不去重不排序", [[F, "const seqs = [...new Set([...s[1]!.matchAll(/#(\\d+)/g)].map((m) => Number(m[1])))].sort((x, y) => x - y);", "const seqs = [...s[1]!.matchAll(/#(\\d+)/g)].map((m) => Number(m[1]));"]], "要点解析"],
  ["F12 截断了不告诉模型", [[F, "const truncated = i.lines.length < i.messageCount;", "const truncated = false;"]], "截断如实写进第 5 块"],
  ["F13 basedOnSeq 写成区间终点而不是读到的最后一条", [[F, "basedOnSeq: { [i.roomId]: last } }", "basedOnSeq: { [i.roomId]: i.toSeqInclusive } }"]], "截断如实写进第 5 块"],
  ["F14 第 1 块不带缓存断点", [[F, "cacheBreakpoint: n === 1 });", "cacheBreakpoint: false });"]], "五块"],
  ["F15 第 4 块的消息不带 seq", [[F, "return `#${l.seq} · ${l.senderName}(", "return `${l.senderName}("]], "五块"],
  ["F16 只读的规矩没写进第 1 块", [[F, "  \"5 这一轮是只读的:不要派活、交付、下验收结论、停止任务、登记承诺或写记忆;消息里提到的待办只在要点里如实转述,不替任何人同意、关闭或推进。\",\n", ""]], "五块"],
];

const TIMEOUT_MS = Number(process.env.MUT_TIMEOUT_MS ?? 300_000);
const ONLY = process.env.MUT_ONLY ? new Set(process.env.MUT_ONLY.split(",")) : null;
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `${TAG}-`));
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
// MUT_DRY=1:只核对每处注入点在原文里恰好出现 1 次,不跑测试
if (process.env.MUT_DRY) {
  for (const [name, edits] of M) {
    const seen = new Map();
    for (const [file, from, to] of edits) {
      const src = seen.get(file) ?? fs.readFileSync(path.join(ROOT, file), "utf8");
      const n = count(src, from);
      if (n !== 1) {
        ok = false;
        console.log(`✗ ${name}:${file} 注入点出现 ${n} 次`);
      }
      seen.set(file, src.replace(from, () => to));
    }
  }
  console.log(ok ? `注入点核对通过(${M.length} 个变异)` : "注入点核对失败");
  process.exit(ok ? 0 : 1);
}
const clean = await run(copy("clean"));
const good = !clean.timedOut && clean.code === 0 && clean.failed.length === 0 && clean.passed.length > 0;
console.log(`${good ? "✓" : "✗"} 原样副本:${clean.passed.length} 绿 / ${clean.failed.length} 红${clean.failed.length ? `(${clean.failed.join(";")})` : ""}`);
if (!good) ok = false;
const named = new Set(clean.passed);
let killed = 0;
let survived = 0;
for (const [i, [name, edits, expect]] of M.entries()) {
  const tag = `[${i + 1}/${M.length}]`;
  if (ONLY && !ONLY.has(name.split(" ")[0])) continue;
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
    fs.writeFileSync(f, src.replace(from, () => to));
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
  // 每个变异点名一条必须发现它的测试(标题开头);这条没红,别的红了也算存活
  const hit = kills.some((k) => k.startsWith(expect));
  if (!r.timedOut && hit) {
    killed++;
    console.log(`✓ ${tag} ${name}:${r.passed.length} 绿 / ${r.failed.length} 红,用时 ${((Date.now() - t0) / 1000).toFixed(1)}s,被发现:${kills.map((k) => `「${k}」`).join("")}`);
  } else {
    ok = false;
    survived++;
    console.log(`✗ ${tag} ${name}:${r.timedOut ? "超时" : `${r.passed.length} 绿 / ${r.failed.length} 红,存活(指定的「${expect}」没红${kills.length ? `;红的是:${kills.map((k) => `「${k}」`).join("")}` : ""})`}`);
  }
}
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`合计 ${killed + survived}${killed + survived === M.length ? "" : `(清单共 ${M.length},这次只跑点名的)`}:杀死 ${killed},存活 ${survived}`);
console.log(ok ? "变异校准通过" : "变异校准失败");
process.exit(ok ? 0 : 1);
