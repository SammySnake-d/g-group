# 收据格式

每个改代码的 PR 一份:`receipts/<分支名,非字母数字换成 ->.json`。

```json
{
  "slice": "PR 做的那条端到端路径,一句话",
  "acceptance": [
    { "id": "AC-05", "status": "通过", "evidence": "packages/x/proof/ac05.txt" },
    { "id": "AC-21", "status": "未测", "reason": "依赖 CAS 原语,下一片做" },
    { "id": "AC-12", "status": "不适用", "reason": "...", "approver": "39impacts.talent g-group#..." }
  ],
  "author": { "agent": "claude", "session": "claude:<会话id>", "model": "claude-opus-5-5" },
  "red": { "commit": "<测试 + 空壳实现的那个提交>" },
  "unverifiable": "第 7 栏:我为什么相信这次绿,它可能被哪个检查骗过,必须点到一个具体条目 ID",
  "waiver": null,
  "review": {
    "agent": "astra", "session": "codex:<会话id>", "model": "gpt-6-astra",
    "verdict": "approve", "reviewed_hash": "<run-all.ts --hash 的输出>",
    "notes": "逐条复现结果,或指向 reviews/<分支>.md"
  }
}
```

- `status` 只能是 通过 / 失败 / 未测 / 不适用(R-08)。通过必须有仓库内的证据文件;未测写原因;不适用写理由和批准人。
- `session` 是 mirasim 会话 `<harness>:<id>`(harness 只能是 claude/codex/pi,id 只含字母、数字和 -;审查会话必须是 codex),对应 `~/.mirasim/sessions/<harness>/<id>/turns.jsonl`。G-PROVENANCE 用它核对实际模型,不认自报。
- `red.commit`:门禁会自己算出本 PR 新增或改动了哪些测试(按文件 + 测试名,和 base 比对测试体),要求每一条都在这个提交上按名字失败。不用手写测试名。
- `waiver` 只有仓库所有者 39impacts.talent(uid usr_4f6ca5e0d86b4a73b5575724ab172bb0)能给:`by` 写 `39impacts.talent`,`reason` 写 `g-group#<消息号>`。那条消息必须是所有者本人直接发的(不是转发或代发),正文里有且只有一处整行指令 `批准豁免 PR#<号> <当前内容 hash 前 12 位>`,不在引号、引用块或代码块里;之后被引用、编辑、撤回即失效。记为 Waived,不算合规通过。
- `review.reviewed_hash` 必须是审查人在自己会话里跑 `run-all.ts --hash` 的输出。G-PROVENANCE 去会话原始记录里找这次工具调用,审查厂商取那一轮的模型。
- 审查人的详细意见写在 `reviews/` 下;`reviews/` 和 `receipts/` 不进内容 hash,写审查意见不会让 hash 失效。
