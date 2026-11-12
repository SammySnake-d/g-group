// U08/U09 创建额度:真 service/SQLite,配置与幂等记录同事务;租约验证复用真实 Host/QuotaTable 路径。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, afterEach, test } from "node:test";
import { all, getDoc, run } from "./db.ts";
import { Host } from "./host.ts";
import { createService } from "./service.ts";

const root = mkdtempSync(path.join(tmpdir(), "gg-create-quota-"));
const hosts = new Set<Host>();
let number = 0;
const make = (file = path.join(root, `${++number}.db`), opts: Partial<ConstructorParameters<typeof Host>[0]> = {}) => {
  const host = new Host({ file, mind: () => ({ async round() { return { actions: [], stateNote: null }; } }), ...opts });
  hosts.add(host);
  return { host, file };
};
const close = async (host: Host) => { hosts.delete(host); await host.close(); };
afterEach(async () => { for (const host of hosts) await close(host); });
after(() => rmSync(root, { recursive: true, force: true }));

test("CQ01 contacts.create 在创建事务持久化指定个人额度与首版历史", async () => {
  const { host } = make();
  const svc = createService(host);
  const result = await svc.handle("contacts.create", { clientActionId: "cq-contact", name: "创建即限额", computeSlots: 2 });
  assert.ok(result.ok);
  const id = (result.value as { id: string }).id;
  assert.equal(host.contactDoc(id).value.computeSlots, 2);
  assert.deepEqual(host.contactHistory(id).versions.map((v) => [v.version, v.kind, v.config.computeSlots]), [[1, "create", 2]]);
});
