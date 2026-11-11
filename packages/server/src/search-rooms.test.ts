// U32(已定):全局搜联系人和群——会话列表的搜索框按会话标题与联系人名匹配,大小写不敏感、中文子串也算命中;
// 只列自己所在的会话,按会话最近更新倒序;每条带 roomId、类型、标题、命中字段与命中位置(给界面高亮)。
// 聊天窗口里搜记录是 search.messages(AC-25),不在本文件。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import type { RoomSearchHit } from "@g-group/api-contract";
import type { ContactMind } from "@g-group/kernel";
import { Host } from "./host.ts";
import { createService } from "./service.ts";

const dir = mkdtempSync(path.join(tmpdir(), "gg-search-rooms-"));
after(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
const file = () => path.join(dir, `s${++n}.db`);
let tick = 0;
/** 每次取时间递增一秒:会话的最近更新时间可判定排序。 */
const clock = () => new Date(Date.UTC(2026, 10, 12, 0, 0, tick++)).toISOString();
/** 不说话的联系人:只测搜索,不跑轮次。 */
const silent = (): ContactMind => ({ round: async () => ({ actions: [], stateNote: null }) });
const opts = (f = file()) => ({ file: f, mind: silent, now: clock, maxDeferMs: 60_000 });
/** 会话清单:一个私聊(标题=联系人名)+ 两个群,一位联系人同时在两个群里。 */
function seed(host: Host) {
  const ck = host.createContact({ name: "小克" });
  const al = host.createContact({ name: "Alice" });
  const dmCk = host.openDm(ck.id);
  const dmAl = host.openDm(al.id);
  const login = host.createGroup("登录组", [{ kind: "contact", id: ck.id }, { kind: "contact", id: al.id }]);
  const ops = host.createGroup("运维值班", [{ kind: "contact", id: ck.id }]);
  return { ck, al, dmCk, dmAl, login, ops };
}
/** 命中的位置必须真的指着关键词。 */
const marks = (hit: RoomSearchHit) => hit.highlights.map((h) => (hit.matchedIn === "title" ? hit.title : (hit.matchedName ?? "")).slice(h.start, h.start + h.length));

test("U32 全局搜联系人和群:命中群标题与联系人名,大小写不敏感、中文子串,带 roomId/类型/标题/命中位置", async () => {
  const host = new Host(opts());
  const s = seed(host);
  const byName = host.searchRooms({ query: "小克" });
  assert.deepEqual(
    byName.map((r) => [r.roomId, r.kind, r.title, r.matchedIn, r.matchedName]).sort(),
    [
      [s.dmCk.id, "dm", "小克", "title", null],
      [s.login.id, "group", "登录组", "contact", "小克"],
      [s.ops.id, "group", "运维值班", "contact", "小克"],
    ].sort(),
    "私聊按标题(就是联系人名)命中,群按成员联系人名命中",
  );
  const top = byName.find((r) => r.roomId === s.login.id)!;
  assert.deepEqual(marks(top), ["小克"], "命中位置指着关键词");
  assert.deepEqual(top.highlights.map((h) => [h.start, h.length]), [[top.matchedName!.indexOf("小克"), 2]]);
  assert.deepEqual(host.searchRooms({ query: "ALICE" }).map((r) => r.roomId).sort(), [s.dmAl.id, s.login.id].sort(), "英文大小写不敏感");
  const cn = host.searchRooms({ query: "登录" });
  assert.deepEqual(cn.map((r) => [r.roomId, r.matchedIn, marks(r)]), [[s.login.id, "title", ["登录"]]], "中文子串命中群标题");
  assert.equal(host.searchRooms({ query: "值班" }).length, 1, "另一个群也能按标题搜到");
  await host.close();
});

test("U32 阴性对照:搜不到的词不返回;多词要全部命中;limit 生效", async () => {
  const host = new Host(opts());
  const s = seed(host);
  assert.deepEqual(host.searchRooms({ query: "不存在的词" }), [], "没有命中就不返回");
  assert.deepEqual(host.searchRooms({ query: "登录 小克" }).map((r) => r.roomId), [s.login.id], "多词全部命中才算(登录在标题、小克在成员名)");
  assert.deepEqual(host.searchRooms({ query: "登录 Alice" }).map((r) => r.roomId), [s.login.id]);
  assert.deepEqual(host.searchRooms({ query: "登录 运维" }), [], "两个词分别落在两个群上不算命中同一个会话");
  assert.deepEqual(host.searchRooms({ query: "小克", limit: 1 }).map((r) => r.roomId), [host.searchRooms({ query: "小克" })[0]!.roomId], "limit 截断到 1 条");
  assert.equal(host.searchRooms({ query: "小克" }).length, 3);
  await host.close();
});

test("U32 经服务层调用 search.rooms:参数与结果符合合同,空查询按合同拒收", async () => {
  const host = new Host(opts());
  const svc = createService(host);
  seed(host);
  const r = await svc.handle("search.rooms", { query: "小克" });
  assert.ok(r.ok, JSON.stringify(r));
  const rooms = (r.value as { rooms: RoomSearchHit[] }).rooms;
  assert.equal(rooms.length, 3);
  assert.deepEqual(Object.keys(rooms[0]!).sort(), ["at", "highlights", "kind", "matchedIn", "matchedName", "roomId", "title"]);
  assert.match(rooms[0]!.at, /^\d{4}-\d{2}-\d{2}T/);
  const bad = await svc.handle("search.rooms", { query: "" });
  assert.equal(!bad.ok && bad.error.code, "invalid_params", "空查询按合同拒收");
  const one = await svc.handle("search.rooms", { query: "小克", limit: 1 });
  assert.ok(one.ok);
  assert.equal((one.value as { rooms: RoomSearchHit[] }).rooms.length, 1);
  await host.close();
});
