// 可复跑的无模型生产路径：安装实际插件，service 执行 /ketchup，读 SQLite 验证只读与持久重放。
// node packages/server/proof/slash-plugins-real.ts
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { MessageView } from "@g-group/api-contract";
import { Host } from "../src/host.ts";
import { createService } from "../src/service.ts";
import { all } from "../src/db.ts";
import { scriptedMind } from "../src/fakes.ts";
const root = mkdtempSync(path.join(os.tmpdir(), "gg-p7-live-"));
const file = path.join(root,"gg.db");
let host = new Host({file,dataDir:path.join(root,"data"),mind:()=>scriptedMind()});
try {
  let svc=createService(host); const room=host.createGroup("插件摘要实跑",[]);
  const installed=await svc.handle("plugins.install",{clientActionId:"install",source:{kind:"local-path",path:fileURLToPath(new URL("../plugins/ketchup",import.meta.url))},grantedPermissions:["chat:read"]});assert.ok(installed.ok);
  host.send({roomId:room.id,clientActionId:"m1",text:"前端闭环另线跟进"});
  host.send({roomId:room.id,clientActionId:"m2",text:"后端命令插件现在可以执行"});
  const before=JSON.stringify({read:all(host.db,"SELECT * FROM gg_read"),effects:all(host.db,"SELECT * FROM gg_effects"),cursor:all(host.db,"SELECT * FROM gg_cursor")});
  const params={roomId:room.id,clientActionId:"k1",text:"/ketchup",command:{name:"ketchup",args:{from:1}}};
  const result=await svc.handle("messages.send",params);assert.ok(result.ok);const m=result.value as MessageView;
  assert.equal(m.sender.kind,"system");assert.ok(m.text.includes("#2 后端命令插件现在可以执行"));assert.ok(!m.text.includes("前端闭环另线跟进"));
  assert.equal(JSON.stringify({read:all(host.db,"SELECT * FROM gg_read"),effects:all(host.db,"SELECT * FROM gg_effects"),cursor:all(host.db,"SELECT * FROM gg_cursor")}),before);
  console.log(m.text);console.log("只读状态比较: unchanged");console.log("命令输出数:",host.listMessages(room.id,{}).messages.filter(x=>x.sender.kind==="system").length);
  await host.close();host=new Host({file,dataDir:path.join(root,"data"),mind:()=>scriptedMind()});svc=createService(host);
  const replay=await svc.handle("messages.send",params);assert.ok(replay.ok);assert.equal((replay.value as MessageView).seq,m.seq);console.log("重启重放: same seq",m.seq);
} finally {await host.close();rmSync(root,{recursive:true,force:true});}
console.log("PASS:真实插件安装、隔离RPC、生产服务、SQLite持久重放；无需模型调用。");
