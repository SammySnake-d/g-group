import assert from "node:assert/strict";
import { test } from "node:test";
import { checkIpcRequest } from "./ipc.ts";

const source = "app://renderer/index.html";
const options = {
  isMethod: (name: string) => ["attachments.upload", "messages.send"].includes(name),
  methodByteLimits: { "attachments.upload": 410_000 },
};

test("IPC 方法限额:附件在专属限额内通过,不再被通用 256 KB 上限截断", () => {
  const params = { name: "截图.png", base64: "A".repeat(400_000) };
  assert.deepEqual(checkIpcRequest({ method: "attachments.upload", params }, source, options), { ok: true, method: "attachments.upload", params });
});

test("IPC 方法限额:超限附件仍拒绝,普通消息与不可信来源不放宽", () => {
  const upload = checkIpcRequest({ method: "attachments.upload", params: { base64: "A".repeat(420_000) } }, source, options);
  assert.equal(upload.ok, false);
  const message = checkIpcRequest({ method: "messages.send", params: { text: "A".repeat(300_000) } }, source, options);
  assert.equal(message.ok, false);
  const foreign = checkIpcRequest({ method: "attachments.upload", params: {} }, "https://outside.example", options);
  assert.equal(foreign.ok, false);
});
